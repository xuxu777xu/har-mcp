import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerTraceValue(server: McpServer): void {
  server.registerTool(
    'trace_value',
    {
      description: 'Track a value\'s origin and propagation across requests',
      inputSchema: z.object({
        value: z.string().describe('The value to search for across all request/response fields'),
        sessionId: z.string().optional().describe('Filter by session ID'),
        limit: z.number().int().min(1).max(500).default(100).optional()
          .describe('Maximum number of matching entries to return (default: 100)'),
      }),
    },
    async (args) => {
      const db = getDb();
      const resultLimit = args.limit ?? 100;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (args.sessionId) {
        conditions.push('sessionId = ?');
        params.push(args.sessionId);
      }

      // Search across multiple fields using LIKE
      const likePattern = `%${args.value}%`;
      const fieldChecks = [
        'requestHeaders LIKE ?',
        'queryString LIKE ?',
        'postDataText LIKE ?',
        'responseHeaders LIKE ?',
        'responseBody LIKE ?',
      ];

      const searchCondition = `(${fieldChecks.join(' OR ')})`;
      conditions.push(searchCondition);
      for (let i = 0; i < fieldChecks.length; i++) {
        params.push(likePattern);
      }

      const whereClause = 'WHERE ' + conditions.join(' AND ');

      // Avoid loading full responseBody into JS — use SQL CASE to flag matches
      const entries = db.prepare(
        `SELECT id, method, url, startedDateTime,
                requestHeaders, queryString, postDataText,
                responseHeaders,
                CASE WHEN responseBody LIKE ? THEN 1 ELSE 0 END AS bodyMatch
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC
         LIMIT ?`
      ).all(likePattern, ...params, resultLimit) as Array<{
        id: string;
        method: string;
        url: string;
        startedDateTime: string;
        requestHeaders: string | null;
        queryString: string | null;
        postDataText: string | null;
        responseHeaders: string | null;
        bodyMatch: number;
      }>;

      interface Occurrence {
        entryId: string;
        method: string;
        url: string;
        startedDateTime: string;
        locations: string[];
      }

      const occurrences: Occurrence[] = [];

      for (const entry of entries) {
        const locations: string[] = [];

        if (entry.requestHeaders && entry.requestHeaders.includes(args.value)) {
          locations.push('requestHeader');
        }
        if (entry.queryString && entry.queryString.includes(args.value)) {
          locations.push('queryParam');
        }
        if (entry.postDataText && entry.postDataText.includes(args.value)) {
          locations.push('requestBody');
        }
        if (entry.responseHeaders && entry.responseHeaders.includes(args.value)) {
          locations.push('responseHeader');
        }
        if (entry.bodyMatch === 1) {
          locations.push('responseBody');
        }

        if (locations.length > 0) {
          occurrences.push({
            entryId: entry.id,
            method: entry.method,
            url: entry.url,
            startedDateTime: entry.startedDateTime,
            locations,
          });
        }
      }

      // Identify first appearance
      let firstAppearance: { entryId: string; location: string; url: string } | null = null;
      if (occurrences.length > 0) {
        const first = occurrences[0];
        firstAppearance = {
          entryId: first.entryId,
          location: first.locations[0],
          url: first.url,
        };
      }

      // Build propagation chain summary
      let propagationChain = 'Value not found in any entries.';
      if (occurrences.length > 0) {
        const chainParts = occurrences.map((o, i) => {
          const locStr = o.locations.join(', ');
          return `${i + 1}. [${o.method} ${o.url}] in ${locStr}`;
        });
        propagationChain = `Value "${args.value}" appears in ${occurrences.length} request(s):\n${chainParts.join('\n')}`;

        // Detect if value originates from a response and propagates to subsequent requests
        const firstResponseIdx = occurrences.findIndex((o) => o.locations.includes('responseBody') || o.locations.includes('responseHeader'));
        const firstRequestIdx = occurrences.findIndex((o) =>
          o.locations.includes('requestHeader') || o.locations.includes('queryParam') || o.locations.includes('requestBody')
        );

        if (firstResponseIdx >= 0 && firstRequestIdx > firstResponseIdx) {
          propagationChain += `\n\nLikely origin: response of ${occurrences[firstResponseIdx].url} (entry ${occurrences[firstResponseIdx].entryId}), then used in subsequent requests.`;
        }
      }

      const result = {
        occurrences,
        firstAppearance,
        propagationChain,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
