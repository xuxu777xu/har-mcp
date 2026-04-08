import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from '../db/connection.js';
import { checkCache } from '../utils/cache.js';
import { parseHarFile } from '../parser/stream-parser.js';

export function registerLoadHar(server: McpServer): void {
  server.registerTool("load_har", {
    description: "Load and parse a HAR file into the SQLite cache for analysis",
    inputSchema: z.object({
      filePath: z.string(),
    }),
  }, async (args) => {
    const filePath = path.resolve(args.filePath);

    // Check cache first
    const cache = checkCache(filePath);
    if (cache.valid && cache.sessionId) {
      const db = getDb();
      const session = db.prepare(
        'SELECT id, fileName, entryCount, domains, timeRange FROM sessions WHERE id = ?'
      ).get(cache.sessionId) as {
        id: string;
        fileName: string;
        entryCount: number;
        domains: string;
        timeRange: string;
      };

      const result = {
        sessionId: session.id,
        fileName: session.fileName,
        entryCount: session.entryCount,
        domains: JSON.parse(session.domains) as string[],
        timeRange: JSON.parse(session.timeRange) as { start: string; end: string },
        cached: true,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }

    // Not cached — create session and parse
    const stat = fs.statSync(filePath);
    const sessionId = crypto.randomUUID();
    const fileName = path.basename(filePath);
    const db = getDb();

    db.prepare(`
      INSERT INTO sessions (id, filePath, fileName, fileSize, fileMtime, loadedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      filePath,
      fileName,
      stat.size,
      stat.mtime.toISOString(),
      new Date().toISOString(),
    );

    const parseResult = await parseHarFile(filePath, sessionId);

    const result = {
      sessionId,
      fileName,
      entryCount: parseResult.entryCount,
      domains: parseResult.domains,
      timeRange: parseResult.timeRange,
      cached: false,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
