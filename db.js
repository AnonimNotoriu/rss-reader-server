import Database from "better-sqlite3";

const db = new Database("data.db");

db.exec(`
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE,
  title TEXT,
  category TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedId INTEGER,
  title TEXT,
  link TEXT,
  summary TEXT,
  image TEXT,
  publishedAt DATETIME,
  UNIQUE(link),
  FOREIGN KEY(feedId) REFERENCES feeds(id)
);
`);

export default db;
