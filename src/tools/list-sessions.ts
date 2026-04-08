import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerListSessions(server: McpServer): void {
  server.registerTool("list_sessions", {
    description: "List all loaded HAR sessions with summary info",
    inputSchema: z.object({}),
  }, async () => {
    const db = getDb();
    const rows = db.prepare('SELECT id, fileName, entryCount, domains, timeRange, loadedAt FROM sessions').all() as Array<{
      id: string;
      fileName: string;
      entryCount: number;
      domains: string;
      timeRange: string;
      loadedAt: string;
    }>;

    const sessions = rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      entryCount: row.entryCount,
      domains: JSON.parse(row.domains) as string[],
      timeRange: JSON.parse(row.timeRange) as { start: string; end: string },
      loadedAt: row.loadedAt,
    }));

    return { content: [{ type: "text" as const, text: JSON.stringify(sessions, null, 2) }] };
  });
}
