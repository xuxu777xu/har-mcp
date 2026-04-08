import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

const MIN_VALUE_LENGTH = 8;
const MAX_RECENT_BODIES = 20;

export function registerAnalyzeFlow(server: McpServer): void {
  server.registerTool(
    'analyze_flow',
    {
      description: 'Reconstruct business flow from request sequence with optimized dependency detection',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Filter by session ID'),
        domain: z.string().optional().describe('Filter by domain'),
        timeRange: z.object({
          start: z.string().describe('ISO date string for range start'),
          end: z.string().describe('ISO date string for range end'),
        }).optional().describe('Filter by time range'),
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
      if (args.timeRange) {
        conditions.push('startedDateTime >= ? AND startedDateTime <= ?');
        params.push(args.timeRange.start, args.timeRange.end);
      }

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      const entries = db.prepare(
        `SELECT id, method, url, status, time, startedDateTime,
                queryString, postDataText, responseBody
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC
         LIMIT 200`
      ).all(...params) as Array<{
        id: string;
        method: string;
        url: string;
        status: number;
        time: number;
        startedDateTime: string;
        queryString: string | null;
        postDataText: string | null;
        responseBody: string | null;
      }>;

      // --- Optimized dependency detection using inverted index ---
      // Map: token (string value from response) → entryId
      const tokenIndex = new Map<string, string>();
      // Keep recent response bodies for substring fallback
      const recentBodies: Array<{ entryId: string; body: string }> = [];

      interface FlowStep {
        order: number;
        entryId: string;
        method: string;
        url: string;
        status: number;
        time: number;
        dependsOn?: string;
        note?: string;
      }

      const steps: FlowStep[] = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const step: FlowStep = {
          order: i + 1,
          entryId: entry.id,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          time: entry.time,
        };

        // Collect current request values (query params + post data values)
        const requestValues: string[] = [];

        if (entry.queryString) {
          try {
            const qs = JSON.parse(entry.queryString) as Array<{ name: string; value: string }>;
            for (const p of qs) {
              if (p.value && p.value.length > MIN_VALUE_LENGTH) {
                requestValues.push(p.value);
              }
            }
          } catch { /* skip */ }
        }

        if (entry.postDataText) {
          try {
            const body = JSON.parse(entry.postDataText);
            if (body && typeof body === 'object') {
              extractValues(body, requestValues);
            }
          } catch {
            if (entry.postDataText.length > MIN_VALUE_LENGTH) {
              requestValues.push(entry.postDataText);
            }
          }
        }

        // Check if any request value appeared in a previous response
        // Phase 1: O(1) lookup in inverted index (exact match)
        for (const val of requestValues) {
          const sourceId = tokenIndex.get(val);
          if (sourceId) {
            step.dependsOn = sourceId;
            step.note = `Value "${val.length > 40 ? val.slice(0, 40) + '...' : val}" from response of ${sourceId}`;
            break;
          }
        }

        // Phase 2: substring search in recent bodies only (fallback)
        if (!step.dependsOn) {
          for (const val of requestValues) {
            for (const prev of recentBodies) {
              if (prev.body.includes(val)) {
                step.dependsOn = prev.entryId;
                step.note = `Value "${val.length > 40 ? val.slice(0, 40) + '...' : val}" from response of ${prev.entryId}`;
                break;
              }
            }
            if (step.dependsOn) break;
          }
        }

        steps.push(step);

        // Index this entry's response body tokens for future lookups
        if (entry.responseBody) {
          // Extract JSON string values as exact tokens
          try {
            const body = JSON.parse(entry.responseBody);
            if (body && typeof body === 'object') {
              const tokens: string[] = [];
              extractValues(body, tokens);
              for (const token of tokens) {
                if (!tokenIndex.has(token)) {
                  tokenIndex.set(token, entry.id);
                }
              }
            }
          } catch {
            // Not JSON — skip indexing, rely on substring fallback
          }

          // Maintain recent bodies window for substring search
          recentBodies.push({ entryId: entry.id, body: entry.responseBody });
          if (recentBodies.length > MAX_RECENT_BODIES) {
            recentBodies.shift();
          }
        }
      }

      const dependencyCount = steps.filter((s) => s.dependsOn).length;
      const summary = `Flow contains ${steps.length} requests. ${dependencyCount} requests have detected data dependencies on previous responses.`;

      const result = { steps, summary };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

/** Recursively extract string values longer than MIN_VALUE_LENGTH from an object */
function extractValues(obj: unknown, out: string[]): void {
  if (typeof obj === 'string') {
    if (obj.length > MIN_VALUE_LENGTH) out.push(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) extractValues(item, out);
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      extractValues(val, out);
    }
  }
}
