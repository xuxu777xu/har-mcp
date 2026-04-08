import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

/** Recursively flatten a JSON object into dot-separated key-value pairs. */
function flattenKeys(obj: unknown, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  if (obj === null || obj === undefined) return result;
  if (typeof obj !== 'object') {
    result[prefix] = String(obj);
    return result;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      Object.assign(result, flattenKeys(obj[i], prefix ? `${prefix}[${i}]` : `[${i}]`));
    }
    return result;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object') {
      Object.assign(result, flattenKeys(val, fullKey));
    } else {
      result[fullKey] = String(val ?? '');
    }
  }
  return result;
}

export function registerDiffRequests(server: McpServer): void {
  server.registerTool(
    'diff_requests',
    {
      description: 'Compare multiple requests to find static vs dynamic parameters',
      inputSchema: z.object({
        entryIds: z.array(z.string()).min(2).optional().describe('Specific entry IDs to compare (2 or more, can be cross-session)'),
        urlPattern: z.string().optional().describe('Auto-select entries by URL pattern'),
        sessionId: z.string().optional().describe('Filter by single session ID (used with urlPattern)'),
        sessionIds: z.array(z.string()).optional().describe('Filter by multiple session IDs for cross-session comparison (used with urlPattern)'),
      }),
    },
    async (args) => {
      const db = getDb();

      let entries: Array<{
        id: string;
        queryString: string | null;
        postDataText: string | null;
        requestHeaders: string | null;
      }>;

      if (args.entryIds && args.entryIds.length >= 2) {
        const placeholders = args.entryIds.map(() => '?').join(',');
        entries = db.prepare(
          `SELECT id, queryString, postDataText, requestHeaders
           FROM entries
           WHERE id IN (${placeholders})
           ORDER BY startedDateTime ASC`
        ).all(...args.entryIds) as typeof entries;
      } else if (args.urlPattern) {
        const conditions: string[] = ['urlPattern = ?'];
        const params: unknown[] = [args.urlPattern];

        if (args.sessionIds && args.sessionIds.length > 0) {
          const placeholders = args.sessionIds.map(() => '?').join(',');
          conditions.push(`sessionId IN (${placeholders})`);
          params.push(...args.sessionIds);
        } else if (args.sessionId) {
          conditions.push('sessionId = ?');
          params.push(args.sessionId);
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');
        entries = db.prepare(
          `SELECT id, queryString, postDataText, requestHeaders
           FROM entries ${whereClause}
           ORDER BY startedDateTime ASC
           LIMIT 10`
        ).all(...params) as typeof entries;
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Provide either entryIds (2+) or urlPattern to select entries for comparison' }, null, 2),
          }],
        };
      }

      if (entries.length < 2) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Need at least 2 entries to compare, found ${entries.length}` }, null, 2),
          }],
        };
      }

      // --- Parse query params per entry ---
      const allQueryParams: Array<Record<string, string>> = [];
      for (const entry of entries) {
        const params: Record<string, string> = {};
        if (entry.queryString) {
          try {
            const qs = JSON.parse(entry.queryString) as Array<{ name: string; value: string }>;
            for (const p of qs) {
              params[p.name] = p.value;
            }
          } catch { /* skip */ }
        }
        allQueryParams.push(params);
      }

      // --- Parse body params per entry (recursive flatten) ---
      const allBodyParams: Array<Record<string, string>> = [];
      for (const entry of entries) {
        let params: Record<string, string> = {};
        if (entry.postDataText) {
          try {
            const body = JSON.parse(entry.postDataText);
            if (body && typeof body === 'object') {
              params = flattenKeys(body);
            }
          } catch { /* not JSON */ }
        }
        allBodyParams.push(params);
      }

      // --- Parse headers per entry (select key headers) ---
      const INTERESTING_HEADERS = [
        'authorization', 'cookie', 'content-type', 'accept', 'user-agent',
        'x-token', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
        'x-request-id', 'x-correlation-id', 'referer', 'origin',
      ];

      const allHeaders: Array<Record<string, string>> = [];
      for (const entry of entries) {
        const headers: Record<string, string> = {};
        if (entry.requestHeaders) {
          try {
            const parsed = JSON.parse(entry.requestHeaders) as Array<{ name: string; value: string }>;
            for (const h of parsed) {
              if (INTERESTING_HEADERS.includes(h.name.toLowerCase())) {
                headers[h.name.toLowerCase()] = h.value;
              }
            }
          } catch { /* skip */ }
        }
        allHeaders.push(headers);
      }

      // --- Classify params ---
      const { staticParams: staticQuery, dynamicParams: dynamicQuery } = classifyParams(allQueryParams);
      const { staticParams: staticBody, dynamicParams: dynamicBody } = classifyParams(allBodyParams);
      const { staticParams: staticHeaders, dynamicParams: dynamicHeaders } = classifyParams(allHeaders);

      const result = {
        comparedEntries: entries.length,
        entryIds: entries.map((e) => e.id),
        staticParams: { ...staticQuery, ...staticBody },
        dynamicParams: { ...dynamicQuery, ...dynamicBody },
        staticHeaders,
        dynamicHeaders,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

interface DynamicInfo {
  values: string[];
  pattern: 'increment' | 'timestamp' | 'random' | 'unknown';
}

function classifyParams(
  paramSets: Array<Record<string, string>>,
): { staticParams: Record<string, string>; dynamicParams: Record<string, DynamicInfo> } {
  // Collect all param keys across all entries
  const allKeys = new Set<string>();
  for (const ps of paramSets) {
    for (const key of Object.keys(ps)) {
      allKeys.add(key);
    }
  }

  const staticParams: Record<string, string> = {};
  const dynamicParams: Record<string, DynamicInfo> = {};

  for (const key of allKeys) {
    const values = paramSets.map((ps) => ps[key]).filter((v) => v !== undefined);

    if (values.length === 0) continue;

    const unique = [...new Set(values)];

    if (unique.length === 1) {
      staticParams[key] = unique[0];
    } else {
      dynamicParams[key] = {
        values: values.slice(0, 10),
        pattern: detectPattern(values),
      };
    }
  }

  return { staticParams, dynamicParams };
}

function detectPattern(values: string[]): 'increment' | 'timestamp' | 'random' | 'unknown' {
  // Check for timestamp pattern (10 or 13 digit numbers)
  const allTimestamp = values.every((v) => /^\d{10}$|^\d{13}$/.test(v));
  if (allTimestamp) return 'timestamp';

  // Check for incrementing numbers
  const nums = values.map(Number);
  const allNumeric = values.every((v) => v !== '' && !isNaN(Number(v)));
  if (allNumeric && nums.length >= 2) {
    let isIncrementing = true;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] <= nums[i - 1]) {
        isIncrementing = false;
        break;
      }
    }
    if (isIncrementing) return 'increment';
  }

  // Check for random-looking values (high uniqueness, similar length, alphanumeric)
  const unique = new Set(values);
  const allSimilarLength = values.every((v) => Math.abs(v.length - values[0].length) <= 2);
  const allAlphanumeric = values.every((v) => /^[a-zA-Z0-9_\-]+$/.test(v));

  if (unique.size === values.length && allSimilarLength && allAlphanumeric && values[0].length >= 8) {
    return 'random';
  }

  return 'unknown';
}
