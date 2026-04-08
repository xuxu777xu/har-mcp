import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerAnalyzeFlow(server: McpServer): void {
  server.registerTool(
    'analyze_flow',
    {
      description: 'Reconstruct business flow from request sequence',
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

      // Build a map of previous response bodies for dependency detection
      const previousResponses: Array<{ entryId: string; body: string }> = [];

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
              if (p.value && p.value.length > 8) {
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
            // Not JSON — treat as raw text, check if the whole thing appears
            if (entry.postDataText.length > 8) {
              requestValues.push(entry.postDataText);
            }
          }
        }

        // Check if any request value appeared in a previous response
        for (const val of requestValues) {
          for (const prev of previousResponses) {
            if (prev.body.includes(val)) {
              step.dependsOn = prev.entryId;
              step.note = `Value "${val.length > 40 ? val.slice(0, 40) + '...' : val}" from response of ${prev.entryId}`;
              break;
            }
          }
          if (step.dependsOn) break;
        }

        steps.push(step);

        // Add this entry's response body to the lookup pool
        if (entry.responseBody) {
          previousResponses.push({ entryId: entry.id, body: entry.responseBody });
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

/** Recursively extract string values longer than 8 chars from an object */
function extractValues(obj: unknown, out: string[]): void {
  if (typeof obj === 'string') {
    if (obj.length > 8) out.push(obj);
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
