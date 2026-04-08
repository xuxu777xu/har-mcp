import fs from 'fs';
import path from 'path';
import { getDb } from '../db/connection.js';

export interface CacheCheckResult {
  valid: boolean;
  sessionId?: string;
}

export function checkCache(filePath: string): CacheCheckResult {
  const absPath = path.resolve(filePath);
  const db = getDb();

  const session = db.prepare('SELECT id, fileSize, fileMtime FROM sessions WHERE filePath = ?').get(absPath) as
    | { id: string; fileSize: number; fileMtime: string }
    | undefined;

  if (!session) return { valid: false };

  try {
    const stat = fs.statSync(absPath);
    if (stat.size === session.fileSize && stat.mtime.toISOString() === session.fileMtime) {
      return { valid: true, sessionId: session.id };
    }
  } catch {
    // File may have been deleted
  }

  // Cache invalid — delete old session and entries
  db.prepare('DELETE FROM entries WHERE sessionId = ?').run(session.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

  return { valid: false };
}
