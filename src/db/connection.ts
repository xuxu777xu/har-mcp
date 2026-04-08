import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initSchema } from './schema.js';

const CACHE_DIR = '.har-cache';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const cacheDir = path.resolve(CACHE_DIR);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const dbPath = path.join(cacheDir, 'har_cache.db');
  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  initSchema(db);

  return db;
}
