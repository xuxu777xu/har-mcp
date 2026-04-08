import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

export function registerExtractParamsSchema(server: McpServer): void {
  server.registerTool(
    'extract_params_schema',
    {
      description: 'Infer parameter schema by aggregating requests to the same endpoint',
      inputSchema: z.object({
        urlPattern: z.string().describe('The URL pattern to match (exact match on urlPattern column)'),
        sessionId: z.string().optional().describe('Filter by session ID'),
      }),
    },
    async (args) => {
      const db = getDb();

      const conditions: string[] = ['urlPattern = ?'];
      const params: unknown[] = [args.urlPattern];

      if (args.sessionId) {
        conditions.push('sessionId = ?');
        params.push(args.sessionId);
      }

      const whereClause = 'WHERE ' + conditions.join(' AND ');

      const entries = db.prepare(
        `SELECT queryString, postDataText, responseBody
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC`
      ).all(...params) as Array<{
        queryString: string | null;
        postDataText: string | null;
        responseBody: string | null;
      }>;

      const sampleCount = entries.length;

      if (sampleCount === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ urlPattern: args.urlPattern, sampleCount: 0, message: 'No entries found for this URL pattern' }, null, 2),
          }],
        };
      }

      // --- Query params aggregation ---
      interface ParamSchema {
        type: string;
        required: boolean;
        exampleValues: string[];
        enumValues?: string[];
      }

      const queryParamData = new Map<string, string[]>();

      for (const entry of entries) {
        if (!entry.queryString) continue;
        try {
          const qs = JSON.parse(entry.queryString) as Array<{ name: string; value: string }>;
          for (const p of qs) {
            if (!queryParamData.has(p.name)) {
              queryParamData.set(p.name, []);
            }
            queryParamData.get(p.name)!.push(p.value);
          }
        } catch { /* skip */ }
      }

      const queryParams: Record<string, ParamSchema> = {};
      for (const [name, values] of queryParamData) {
        queryParams[name] = buildParamSchema(name, values, sampleCount);
      }

      // --- Body params aggregation ---
      const bodyParamData = new Map<string, string[]>();
      let parsableBodyCount = 0;

      for (const entry of entries) {
        if (!entry.postDataText) continue;
        try {
          const body = JSON.parse(entry.postDataText);
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            parsableBodyCount++;
            for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
              if (!bodyParamData.has(key)) {
                bodyParamData.set(key, []);
              }
              bodyParamData.get(key)!.push(String(val));
            }
          }
        } catch { /* not JSON */ }
      }

      const bodyParams: Record<string, ParamSchema> = {};
      const bodyBase = parsableBodyCount || sampleCount;
      for (const [name, values] of bodyParamData) {
        bodyParams[name] = buildParamSchema(name, values, bodyBase);
      }

      // --- Response schema from first JSON response ---
      let responseSchema: Record<string, string> | null = null;
      for (const entry of entries) {
        if (!entry.responseBody) continue;
        try {
          const body = JSON.parse(entry.responseBody);
          if (body && typeof body === 'object') {
            responseSchema = {};
            const target = Array.isArray(body) ? (body.length > 0 ? body[0] : null) : body;
            if (target && typeof target === 'object') {
              for (const [key, val] of Object.entries(target as Record<string, unknown>)) {
                responseSchema[key] = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
              }
            }
            break;
          }
        } catch { /* not JSON */ }
      }

      const result = {
        urlPattern: args.urlPattern,
        sampleCount,
        queryParams,
        bodyParams,
        responseSchema,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

function buildParamSchema(
  _name: string,
  values: string[],
  totalCount: number,
): { type: string; required: boolean; exampleValues: string[]; enumValues?: string[] } {
  const type = inferType(values);
  const required = values.length >= totalCount;

  // Deduplicate for examples and enum detection
  const unique = [...new Set(values)];
  const exampleValues = unique.slice(0, 5);

  const result: { type: string; required: boolean; exampleValues: string[]; enumValues?: string[] } = {
    type,
    required,
    exampleValues,
  };

  // Detect enum values: if 10 or fewer unique values
  if (unique.length <= 10 && unique.length > 0) {
    result.enumValues = unique;
  }

  return result;
}

function inferType(values: string[]): string {
  let allNumber = true;
  let allBoolean = true;

  for (const v of values) {
    if (allNumber && (v === '' || isNaN(Number(v)))) {
      allNumber = false;
    }
    if (allBoolean && v !== 'true' && v !== 'false') {
      allBoolean = false;
    }
    if (!allNumber && !allBoolean) break;
  }

  if (allBoolean && values.length > 0) return 'boolean';
  if (allNumber && values.length > 0) return 'number';
  return 'string';
}
