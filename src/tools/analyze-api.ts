import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerAnalyzeApi(server: McpServer): void {
  server.registerTool(
    'analyze_api',
    {
      description: 'Extract and summarize API endpoint patterns from HAR data',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Filter by session ID'),
        domain: z.string().optional().describe('Filter by domain'),
        urlPattern: z.string().optional().describe('Filter by URL pattern (exact match on urlPattern column)'),
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
        conditions.push('urlPattern = ?');
        params.push(args.urlPattern);
      }

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      // Group by urlPattern to get endpoint summaries
      const groups = db.prepare(
        `SELECT urlPattern, GROUP_CONCAT(DISTINCT method) as methods, COUNT(*) as count
         FROM entries ${whereClause}
         GROUP BY urlPattern
         ORDER BY count DESC`
      ).all(...params) as Array<{
        urlPattern: string;
        methods: string;
        count: number;
      }>;

      const AUTH_HEADER_NAMES = [
        'authorization', 'cookie', 'x-token', 'x-api-key', 'x-auth-token',
        'x-csrf-token', 'x-xsrf-token', 'bearer', 'api-key', 'access-token',
      ];

      const endpoints = groups.map((group) => {
        // Fetch sample entries for this urlPattern
        const sampleConditions = [...conditions, 'urlPattern = ?'];
        const sampleParams = [...params, group.urlPattern];
        const sampleWhere = 'WHERE ' + sampleConditions.join(' AND ');

        const entries = db.prepare(
          `SELECT id, queryString, postDataText, requestHeaders, responseBody
           FROM entries ${sampleWhere}
           ORDER BY startedDateTime ASC
           LIMIT 10`
        ).all(...sampleParams) as Array<{
          id: string;
          queryString: string | null;
          postDataText: string | null;
          requestHeaders: string | null;
          responseBody: string | null;
        }>;

        // Collect request param keys
        const queryParamKeys = new Set<string>();
        const bodyParamKeys = new Set<string>();
        const authHeaders = new Set<string>();

        for (const entry of entries) {
          // Query string params
          if (entry.queryString) {
            try {
              const qs = JSON.parse(entry.queryString) as Array<{ name: string }>;
              for (const p of qs) {
                queryParamKeys.add(p.name);
              }
            } catch { /* skip malformed */ }
          }

          // Post data JSON keys
          if (entry.postDataText) {
            try {
              const body = JSON.parse(entry.postDataText);
              if (body && typeof body === 'object' && !Array.isArray(body)) {
                for (const key of Object.keys(body)) {
                  bodyParamKeys.add(key);
                }
              }
            } catch { /* not JSON, skip */ }
          }

          // Auth-related headers
          if (entry.requestHeaders) {
            try {
              const headers = JSON.parse(entry.requestHeaders) as Array<{ name: string; value: string }>;
              for (const h of headers) {
                if (AUTH_HEADER_NAMES.includes(h.name.toLowerCase())) {
                  authHeaders.add(h.name);
                }
              }
            } catch { /* skip */ }
          }
        }

        // Response structure from first entry with a JSON body
        let responseStructure: Record<string, string> | null = null;
        for (const entry of entries) {
          if (entry.responseBody) {
            try {
              const body = JSON.parse(entry.responseBody);
              if (body && typeof body === 'object') {
                responseStructure = {};
                const target = Array.isArray(body) ? (body.length > 0 ? body[0] : null) : body;
                if (target && typeof target === 'object') {
                  for (const [key, val] of Object.entries(target)) {
                    responseStructure[key] = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
                  }
                }
              }
              break;
            } catch { /* not JSON */ }
          }
        }

        // Sample entry IDs (up to 3)
        const sampleIds = entries.slice(0, 3).map((e) => e.id);

        return {
          urlPattern: group.urlPattern,
          methods: group.methods.split(','),
          requestCount: group.count,
          queryParamKeys: [...queryParamKeys],
          bodyParamKeys: [...bodyParamKeys],
          authHeaders: [...authHeaders],
          responseStructure,
          sampleEntryIds: sampleIds,
        };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(endpoints, null, 2) }],
      };
    },
  );
}
