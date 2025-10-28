// ===============================
//  Smart RSS Backend with Cache + Image Previews
// ===============================
import { fileURLToPath } from "url";
import path from "path";
import express from "express";
import cors from "cors";
import RSSParser from "rss-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import db from "./db.js";

dotenv.config();

const app = express();
const port = 3001;

const parser = new RSSParser({
  requestOptions: {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/118.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
  },
});

app.use(cors());
app.use(express.json());

// Resolve YouTube handle → RSS URL
async function resolveYouTubeHandle(url) {
  try {
    const html = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    }).then((r) => r.text());
    const match = html.match(/"channelId":"(UC[0-9A-Za-z_-]+)"/);
    if (match && match[1]) {
      return `https://www.youtube.com/feeds/videos.xml?channel_id=${match[1]}`;
    }
  } catch (err) {
    console.error("Failed to resolve YouTube handle:", err.message);
  }
  return null;
}

// Fetch & normalize feeds
app.get("/api/fetch", async (req, res) => {
  let feedUrl = req.query.url;
  if (!feedUrl) return res.status(400).json({ error: "Missing ?url=" });

  try {
    // --- YouTube ---
    if (feedUrl.includes("youtube.com")) {
      if (/youtube\.com\/@/.test(feedUrl)) {
        const resolved = await resolveYouTubeHandle(feedUrl);
        if (resolved) feedUrl = resolved;
        else throw new Error("Unable to resolve YouTube handle");
      }

      const channelMatch = feedUrl.match(/youtube\.com\/channel\/([A-Za-z0-9_\-]+)/);
      if (channelMatch)
        feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`;

      const playlistMatch = feedUrl.match(/list=([A-Za-z0-9_\-]+)/);
      if (playlistMatch)
        feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`;
    }

    // --- Twitter/X ---
    if (feedUrl.includes("twitter.com") || feedUrl.includes("x.com")) {
      const match = feedUrl.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/);
      if (match && match[1]) {
        const username = match[1];
        console.log(`🔁 Using Twitter API for ${username}`);

        const client = new TwitterApi({
          appKey: process.env.TWITTER_APP_KEY,
          appSecret: process.env.TWITTER_APP_SECRET,
          accessToken: process.env.TWITTER_ACCESS_TOKEN,
          accessSecret: process.env.TWITTER_ACCESS_SECRET,
        });

        const user = await client.v2.userByUsername(username);
        const tweets = await client.v2.userTimeline(user.data.id, {
          max_results: 10,
          "tweet.fields": ["created_at", "text"],
        });

        const items = tweets.data?.data?.map((t) => ({
          title: t.text.slice(0, 80),
          link: `https://x.com/${username}/status/${t.id}`,
          summary: t.text,
          image: null,
          publishedAt: t.created_at,
          feedTitle: `Tweets by ${username}`,
        }));

        const feedStmt = db.prepare("INSERT OR IGNORE INTO feeds (url, title) VALUES (?, ?)");
        feedStmt.run(feedUrl, `Tweets by ${username}`);
        const feedRow = db.prepare("SELECT id FROM feeds WHERE url = ?").get(feedUrl);

        const articleStmt = db.prepare(`
          INSERT OR IGNORE INTO articles (feedId, title, link, summary, image, publishedAt)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const item of items) {
          articleStmt.run(feedRow.id, item.title, item.link, item.summary, item.image, item.publishedAt);
        }

        return res.json({ title: `Tweets by ${username}`, url: feedUrl, items });
      }
    }

    // --- Normal RSS ---
    console.log(`🔍 Fetching feed: ${feedUrl}`);
    const feed = await parser.parseURL(feedUrl);

    const items = (feed.items || []).map((item) => {
      let image = null;
      const html = item["content:encoded"] || item.content || "";
      const match = html.match(/<img[^>]+src="([^">]+)"/i);
      if (match) image = match[1];
      if (!image && item.enclosure?.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(item.enclosure.url)) {
        image = item.enclosure.url;
      }

      return {
        title: item.title,
        link: item.link,
        summary: item.contentSnippet || item.summary || "",
        image,
        publishedAt: item.isoDate || item.pubDate,
        feedTitle: feed.title,
      };
    });

    const feedStmt = db.prepare("INSERT OR IGNORE INTO feeds (url, title) VALUES (?, ?)");
    feedStmt.run(feedUrl, feed.title);
    const feedRow = db.prepare("SELECT id FROM feeds WHERE url = ?").get(feedUrl);

    const articleStmt = db.prepare(`
      INSERT OR IGNORE INTO articles (feedId, title, link, summary, image, publishedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      articleStmt.run(feedRow.id, item.title, item.link, item.summary, item.image, item.publishedAt);
    }

    res.json({ title: feed.title, url: feedUrl, items });
  } catch (err) {
    console.error("Error parsing feed:", err.message);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

// Feed management
app.get("/api/feeds", (req, res) => {
  const feeds = db.prepare("SELECT * FROM feeds ORDER BY createdAt DESC").all();
  res.json(feeds);
});

app.delete("/api/feeds/:id", (req, res) => {
  const id = req.params.id;
  db.prepare("DELETE FROM articles WHERE feedId = ?").run(id);
  const result = db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
  res.json({ success: result.changes > 0 });
});

app.post("/api/feeds/:id/category", (req, res) => {
  const id = req.params.id;
  const { category } = req.body;
  db.prepare("UPDATE feeds SET category = ? WHERE id = ?").run(category, id);
  res.json({ success: true });
});

// Cached articles + search
app.get("/api/articles", (req, res) => {
  const { q } = req.query;
  let rows;
  if (q) {
    rows = db
      .prepare(
        `SELECT a.*, f.title AS feedTitle, f.category FROM articles a
         JOIN feeds f ON a.feedId = f.id
         WHERE a.title LIKE ? OR a.summary LIKE ?
         ORDER BY a.publishedAt DESC`
      )
      .all(`%${q}%`, `%${q}%`);
  } else {
    rows = db
      .prepare(
        `SELECT a.*, f.title AS feedTitle, f.category FROM articles a
         JOIN feeds f ON a.feedId = f.id
         ORDER BY a.publishedAt DESC LIMIT 100`
      )
      .all();
  }
  res.json(rows);
});

// Auto-refresh feeds every 15 min
const REFRESH_INTERVAL = 15 * 60 * 1000;

async function refreshFeed(feedUrl) {
  try {
    const res = await fetch(`http://localhost:${port}/api/fetch?url=${encodeURIComponent(feedUrl)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feedRow = db.prepare("SELECT id FROM feeds WHERE url = ?").get(feedUrl);
    db.prepare("UPDATE feeds SET lastUpdated = CURRENT_TIMESTAMP WHERE id = ?").run(feedRow.id);
    console.log(`✅ Refreshed: ${feedUrl}`);
  } catch (err) {
    console.warn(`⚠ Failed to refresh ${feedUrl}: ${err.message}`);
  }
}

async function refreshFeeds() {
  const feeds = db.prepare("SELECT url FROM feeds").all();
  console.log(`🔁 Auto-refreshing ${feeds.length} feeds...`);
  for (const feed of feeds) await refreshFeed(feed.url);
}

setInterval(refreshFeeds, REFRESH_INTERVAL);

// Manual refresh endpoint
app.post("/api/feeds/refresh", async (req, res) => {
  try {
    await refreshFeeds();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Refresh failed" });
  }
});

// --- Mark article as read/unread ---
app.post("/api/articles/:id/read", (req, res) => {
  const { id } = req.params;
  const { isRead } = req.body;
  db.prepare("UPDATE articles SET isRead = ? WHERE id = ?").run(isRead ? 1 : 0, id);
  res.json({ success: true });
});

// --- Bookmark/unbookmark article ---
app.post("/api/articles/:id/bookmark", (req, res) => {
  const { id } = req.params;
  const { isBookmarked } = req.body;
  db.prepare("UPDATE articles SET isBookmarked = ? WHERE id = ?").run(isBookmarked ? 1 : 0, id);
  res.json({ success: true });
});

import fs from "fs";
import { parseStringPromise, Builder } from "xml2js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Export feeds to OPML ---
app.get("/api/feeds/export", (req, res) => {
  const feeds = db.prepare("SELECT * FROM feeds").all();
  const opml = {
    opml: {
      $: { version: "2.0" },
      head: [{ title: "My RSS Feeds Export" }],
      body: [
        {
          outline: feeds.map((f) => ({
            $: {
              type: "rss",
              text: f.title || f.url,
              xmlUrl: f.url,
              category: f.category || "",
            },
          })),
        },
      ],
    },
  };
  const builder = new Builder();
  const xml = builder.buildObject(opml);
  res.setHeader("Content-Type", "text/xml");
  res.setHeader("Content-Disposition", "attachment; filename=feeds.opml");
  res.send(xml);
});

// --- Import feeds from OPML ---
app.post("/api/feeds/import", async (req, res) => {
  try {
    const xml = req.body.xml;
    if (!xml) return res.status(400).json({ error: "Missing OPML XML data" });

    const result = await parseStringPromise(xml);
    const outlines = result.opml.body[0].outline || [];

    const feedStmt = db.prepare(
      "INSERT OR IGNORE INTO feeds (url, title, category) VALUES (?, ?, ?)"
    );

    outlines.forEach((o) => {
      const feed = o.$;
      feedStmt.run(feed.xmlUrl, feed.text, feed.category || null);
    });

    res.json({ success: true });
  } catch (err) {
    console.error("OPML import failed:", err.message);
    res.status(500).json({ error: "Invalid OPML file" });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve built frontend
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
});
