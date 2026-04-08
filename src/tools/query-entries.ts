import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerQueryEntries(server: McpServer): void {
  server.registerTool(
    'query_entries',
    {
      description: 'Query and filter HAR entries with flexible criteria',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        domain: z.string().optional(),
        urlPattern: z.string().optional().describe('LIKE pattern matched against url'),
        method: z.string().optional(),
        statusCode: z.number().int().optional(),
        mimeType: z.string().optional().describe('LIKE pattern matched against responseMimeType'),
        search: z.string().optional().describe('LIKE search across url and postDataText'),
        limit: z.number().int().min(1).max(200).default(50).optional(),
        offset: z.number().int().min(0).default(0).optional(),
      }),
    },
    async (args) => {
      const db = getDb();

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (args.sessionId) {
        conditions.push('sessionId = ?');
        params.push(args.sessionId);
      }
      if (args.domain) {
        conditions.push('domain = ?');
        params.push(args.domain);
      }
      if (args.urlPattern) {
        conditions.push('url LIKE ?');
        params.push(`%${args.urlPattern}%`);
      }
      if (args.method) {
        conditions.push('method = ?');
        params.push(args.method.toUpperCase());
      }
      if (args.statusCode !== undefined) {
        conditions.push('status = ?');
        params.push(args.statusCode);
      }
      if (args.mimeType) {
        conditions.push('responseMimeType LIKE ?');
        params.push(`%${args.mimeType}%`);
      }
      if (args.search) {
        conditions.push('(url LIKE ? OR postDataText LIKE ?)');
        const searchPattern = `%${args.search}%`;
        params.push(searchPattern, searchPattern);
      }

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;

      const countRow = db.prepare(
        `SELECT COUNT(*) as total FROM entries ${whereClause}`
      ).get(...params) as { total: number };

      const rows = db.prepare(
        `SELECT id, method, url, status, responseMimeType, responseSize, time, startedDateTime
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC
         LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as Array<{
        id: string;
        method: string;
        url: string;
        status: number;
        responseMimeType: string | null;
        responseSize: number | null;
        time: number;
        startedDateTime: string;
      }>;

      const result = {
        totalCount: countRow.total,
        entries: rows,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
