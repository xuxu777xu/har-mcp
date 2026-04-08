import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      filePath      TEXT NOT NULL UNIQUE,
      fileName      TEXT NOT NULL,
      fileSize      INTEGER NOT NULL,
      fileMtime     TEXT NOT NULL,
      entryCount    INTEGER NOT NULL DEFAULT 0,
      domains       TEXT NOT NULL DEFAULT '[]',
      timeRange     TEXT NOT NULL DEFAULT '{}',
      loadedAt      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id                TEXT PRIMARY KEY,
      sessionId         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      startedDateTime   TEXT NOT NULL,
      time              REAL NOT NULL,

      method            TEXT NOT NULL,
      url               TEXT NOT NULL,
      domain            TEXT NOT NULL,
      path              TEXT NOT NULL,
      httpVersion       TEXT,
      queryString       TEXT,
      requestHeaders    TEXT,
      requestCookies    TEXT,
      postDataMimeType  TEXT,
      postDataText      TEXT,

      status            INTEGER NOT NULL,
      statusText        TEXT,
      responseMimeType  TEXT,
      responseHeaders   TEXT,
      responseBody      TEXT,
      responseBodyLength INTEGER,
      responseSize      INTEGER,

      urlPattern        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(sessionId);
    CREATE INDEX IF NOT EXISTS idx_entries_domain ON entries(domain);
    CREATE INDEX IF NOT EXISTS idx_entries_method ON entries(method);
    CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
    CREATE INDEX IF NOT EXISTS idx_entries_urlPattern ON entries(urlPattern);
    CREATE INDEX IF NOT EXISTS idx_entries_time ON entries(startedDateTime);
  `);
}
