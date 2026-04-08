import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerGetEntryDetail(server: McpServer): void {
  server.registerTool(
    'get_entry_detail',
    {
      description: 'Get complete details of a single HTTP request/response',
      inputSchema: z.object({
        entryId: z.string().describe('The entry ID to retrieve'),
      }),
    },
    async (args) => {
      const db = getDb();

      const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(args.entryId) as
        | Record<string, unknown>
        | undefined;

      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Entry not found: ${args.entryId}` }) }],
          isError: true,
        };
      }

      const jsonFields = ['requestHeaders', 'responseHeaders', 'queryString', 'requestCookies'] as const;
      for (const field of jsonFields) {
        const value = row[field];
        if (typeof value === 'string') {
          try {
            row[field] = JSON.parse(value);
          } catch {
            // keep as raw string if parse fails
          }
        }
      }

      // Check if responseBody was truncated
      const bodyLength = row.responseBodyLength as number | null;
      const actualBody = row.responseBody as string | null;
      if (bodyLength != null && actualBody != null && bodyLength > actualBody.length) {
        row._note = `Response body was truncated: stored ${actualBody.length} chars of original ${bodyLength}`;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(row, null, 2) }],
      };
    },
  );
}
