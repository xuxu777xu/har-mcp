import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

function extractSnippet(text: string, pattern: string | RegExp, contextChars = 100): string {
  let idx: number;
  let matchLen: number;

  if (pattern instanceof RegExp) {
    const m = pattern.exec(text);
    if (!m) return text.slice(0, 200);
    idx = m.index;
    matchLen = m[0].length;
  } else {
    const lowerText = text.toLowerCase();
    const lowerPattern = pattern.toLowerCase();
    idx = lowerText.indexOf(lowerPattern);
    if (idx === -1) return text.slice(0, 200);
    matchLen = pattern.length;
  }

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + matchLen + contextChars);
  let snippet = text.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}

export function registerSearchBodies(server: McpServer): void {
  server.registerTool(
    'search_bodies',
    {
      description: 'Full-text search across request and response bodies with regex support',
      inputSchema: z.object({
        pattern: z.string().describe('Text pattern or regex to search for'),
        sessionId: z.string().optional(),
        scope: z.enum(['request', 'response', 'both']).default('both').optional()
          .describe('Which bodies to search: request, response, or both'),
        limit: z.number().int().min(1).max(200).default(20).optional(),
        regex: z.boolean().default(false).optional()
          .describe('Treat pattern as a regular expression'),
        caseSensitive: z.boolean().default(false).optional()
          .describe('Case-sensitive search (default: false)'),
      }),
    },
    async (args) => {
      const db = getDb();

      const scope = args.scope ?? 'both';
      const limit = args.limit ?? 20;
      const useRegex = args.regex ?? false;
      const caseSensitive = args.caseSensitive ?? false;

      let regexObj: RegExp | null = null;
      if (useRegex) {
        try {
          regexObj = new RegExp(args.pattern, caseSensitive ? '' : 'i');
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` }) }],
            isError: true,
          };
        }
      }

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
        if (useRegex) {
          // Regex mode: fetch all non-null rows and filter in JS
          const rows = db.prepare(
            `SELECT id, method, url, postDataText FROM entries
             WHERE postDataText IS NOT NULL${sessionCondition}`
          ).all(...sessionParams) as Array<{
            id: string; method: string; url: string; postDataText: string;
          }>;

          for (const row of rows) {
            if (results.length >= limit) break;
            if (regexObj!.test(row.postDataText)) {
              results.push({
                entryId: row.id,
                method: row.method,
                url: row.url,
                matchField: 'requestBody',
                contextSnippet: extractSnippet(row.postDataText, regexObj!),
              });
              regexObj!.lastIndex = 0;
            }
          }
        } else {
          // Plain text mode with COLLATE NOCASE support
          const collate = caseSensitive ? '' : ' COLLATE NOCASE';
          const likePattern = `%${args.pattern}%`;
          const rows = db.prepare(
            `SELECT id, method, url, postDataText FROM entries
             WHERE postDataText LIKE ?${collate}${sessionCondition}
             LIMIT ?`
          ).all(likePattern, ...sessionParams, limit) as Array<{
            id: string; method: string; url: string; postDataText: string;
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
      }

      if (scope === 'response' || scope === 'both') {
        const remaining = limit - results.length;
        if (remaining > 0) {
          if (useRegex) {
            const rows = db.prepare(
              `SELECT id, method, url, responseBody FROM entries
               WHERE responseBody IS NOT NULL${sessionCondition}`
            ).all(...sessionParams) as Array<{
              id: string; method: string; url: string; responseBody: string;
            }>;

            for (const row of rows) {
              if (results.length >= limit) break;
              if (regexObj!.test(row.responseBody)) {
                results.push({
                  entryId: row.id,
                  method: row.method,
                  url: row.url,
                  matchField: 'responseBody',
                  contextSnippet: extractSnippet(row.responseBody, regexObj!),
                });
                regexObj!.lastIndex = 0;
              }
            }
          } else {
            const collate = caseSensitive ? '' : ' COLLATE NOCASE';
            const likePattern = `%${args.pattern}%`;
            const rows = db.prepare(
              `SELECT id, method, url, responseBody FROM entries
               WHERE responseBody LIKE ?${collate}${sessionCondition}
               LIMIT ?`
            ).all(likePattern, ...sessionParams, remaining) as Array<{
              id: string; method: string; url: string; responseBody: string;
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
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );
}
