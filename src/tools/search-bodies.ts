import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

function extractSnippet(text: string, pattern: string, contextChars = 100): string {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const idx = lowerText.indexOf(lowerPattern);
  if (idx === -1) return text.slice(0, 200);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + pattern.length + contextChars);
  let snippet = text.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}

export function registerSearchBodies(server: McpServer): void {
  server.registerTool(
    'search_bodies',
    {
      description: 'Full-text search across request and response bodies',
      inputSchema: z.object({
        pattern: z.string().describe('Text pattern to search for'),
        sessionId: z.string().optional(),
        scope: z.enum(['request', 'response', 'both']).default('both').optional()
          .describe('Which bodies to search: request, response, or both'),
        limit: z.number().int().min(1).max(200).default(20).optional(),
      }),
    },
    async (args) => {
      const db = getDb();

      const scope = args.scope ?? 'both';
      const limit = args.limit ?? 20;
      const likePattern = `%${args.pattern}%`;

      const results: Array<{
        entryId: string;
        method: string;
        url: string;
        matchField: 'requestBody' | 'responseBody';
        contextSnippet: string;
      }> = [];

      const sessionCondition = args.sessionId ? ' AND sessionId = ?' : '';
      const sessionParams = args.sessionId ? [args.sessionId] : [];

      if (scope === 'request' || scope === 'both') {
        const rows = db.prepare(
          `SELECT id, method, url, postDataText FROM entries
           WHERE postDataText LIKE ?${sessionCondition}
           LIMIT ?`
        ).all(likePattern, ...sessionParams, limit) as Array<{
          id: string;
          method: string;
          url: string;
          postDataText: string;
        }>;

        for (const row of rows) {
          results.push({
            entryId: row.id,
            method: row.method,
            url: row.url,
            matchField: 'requestBody',
            contextSnippet: extractSnippet(row.postDataText, args.pattern),
          });
        }
      }

      if (scope === 'response' || scope === 'both') {
        const remaining = limit - results.length;
        if (remaining > 0) {
          const rows = db.prepare(
            `SELECT id, method, url, responseBody FROM entries
             WHERE responseBody LIKE ?${sessionCondition}
             LIMIT ?`
          ).all(likePattern, ...sessionParams, remaining) as Array<{
            id: string;
            method: string;
            url: string;
            responseBody: string;
          }>;

          for (const row of rows) {
            results.push({
              entryId: row.id,
              method: row.method,
              url: row.url,
              matchField: 'responseBody',
              contextSnippet: extractSnippet(row.responseBody, args.pattern),
            });
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );
}
