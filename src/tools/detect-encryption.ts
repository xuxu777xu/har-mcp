import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

const CRYPTO_NAME_PATTERN = /sign|signature|hash|hmac|nonce|timestamp|encrypt|cipher|digest|checksum|mac|iv|salt|secret/i;

/** Calculate Shannon entropy of a string (bits per character). */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Standard deviation of an array of numbers. */
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

interface SuspiciousParam {
  paramName: string;
  source: 'query' | 'body';
  urlPattern: string;
  avgEntropy: number;
  avgLength: number;
  lengthStdDev: number;
  nameMatch: boolean;
  confidence: 'high' | 'medium' | 'low';
  sampleValues: string[];
  requestCount: number;
}

export function registerDetectEncryption(server: McpServer): void {
  server.registerTool(
    'detect_encryption',
    {
      description: 'Detect likely encrypted/signed/hashed parameters by analyzing entropy, length consistency, and naming patterns',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Filter by session ID'),
        domain: z.string().optional().describe('Filter by domain'),
        urlPattern: z.string().optional().describe('Filter by specific URL pattern'),
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

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // Get endpoints with 3+ requests (need multiple samples for comparison)
      const endpoints = db.prepare(
        `SELECT urlPattern, COUNT(*) as cnt
         FROM entries ${whereClause}
         GROUP BY urlPattern
         HAVING cnt >= 3
         ORDER BY cnt DESC
         LIMIT 50`
      ).all(...params) as Array<{ urlPattern: string; cnt: number }>;

      const suspiciousParams: SuspiciousParam[] = [];

      for (const endpoint of endpoints) {
        // Fetch entries for this endpoint
        const epConditions = [...conditions, 'urlPattern = ?'];
        const epParams = [...params, endpoint.urlPattern];
        const epWhere = 'WHERE ' + epConditions.join(' AND ');

        const entries = db.prepare(
          `SELECT queryString, postDataText
           FROM entries ${epWhere}
           ORDER BY startedDateTime ASC
           LIMIT 20`
        ).all(...epParams) as Array<{
          queryString: string | null;
          postDataText: string | null;
        }>;

        // Collect parameter values across entries
        const queryParamValues = new Map<string, string[]>();
        const bodyParamValues = new Map<string, string[]>();

        for (const entry of entries) {
          if (entry.queryString) {
            try {
              const qs = JSON.parse(entry.queryString) as Array<{ name: string; value: string }>;
              for (const p of qs) {
                if (!queryParamValues.has(p.name)) queryParamValues.set(p.name, []);
                queryParamValues.get(p.name)!.push(p.value);
              }
            } catch { /* skip */ }
          }

          if (entry.postDataText) {
            try {
              const body = JSON.parse(entry.postDataText);
              if (body && typeof body === 'object' && !Array.isArray(body)) {
                for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
                  if (typeof val === 'string' || typeof val === 'number') {
                    if (!bodyParamValues.has(key)) bodyParamValues.set(key, []);
                    bodyParamValues.get(key)!.push(String(val));
                  }
                }
              }
            } catch { /* not JSON */ }
          }
        }

        // Analyze each parameter
        const analyzeParamSet = (paramMap: Map<string, string[]>, source: 'query' | 'body') => {
          for (const [name, values] of paramMap) {
            // Only check dynamic params (at least 2 unique values)
            const uniqueValues = new Set(values);
            if (uniqueValues.size < 2) continue;
            if (values.length < 3) continue;

            // Calculate metrics
            const entropies = values.map(shannonEntropy);
            const avgEntropy = entropies.reduce((a, b) => a + b, 0) / entropies.length;
            const lengths = values.map((v) => v.length);
            const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
            const lengthSD = stdDev(lengths);
            const nameMatch = CRYPTO_NAME_PATTERN.test(name);

            // Skip very short values or very low entropy
            if (avgLength < 4) continue;
            if (avgEntropy < 2.5 && !nameMatch) continue;

            // Confidence scoring
            let confidence: 'high' | 'medium' | 'low';
            if (avgEntropy > 4.0 && nameMatch) {
              confidence = 'high';
            } else if (avgEntropy > 3.5 || (nameMatch && avgEntropy > 2.5)) {
              confidence = 'medium';
            } else if (avgEntropy > 3.0) {
              confidence = 'low';
            } else {
              continue; // Not suspicious enough
            }

            suspiciousParams.push({
              paramName: name,
              source,
              urlPattern: endpoint.urlPattern,
              avgEntropy: Math.round(avgEntropy * 100) / 100,
              avgLength: Math.round(avgLength),
              lengthStdDev: Math.round(lengthSD * 100) / 100,
              nameMatch,
              confidence,
              sampleValues: values.slice(0, 3).map((v) => v.length > 50 ? v.slice(0, 50) + '...' : v),
              requestCount: values.length,
            });
          }
        };

        analyzeParamSet(queryParamValues, 'query');
        analyzeParamSet(bodyParamValues, 'body');
      }

      // Sort by confidence (high first), then entropy
      const confidenceOrder = { high: 0, medium: 1, low: 2 };
      suspiciousParams.sort((a, b) =>
        confidenceOrder[a.confidence] - confidenceOrder[b.confidence] || b.avgEntropy - a.avgEntropy
      );

      const byConfidence = { high: 0, medium: 0, low: 0 };
      for (const p of suspiciousParams) byConfidence[p.confidence]++;

      const summary = [
        `Scanned ${endpoints.length} endpoints with 3+ requests.`,
        `Found ${suspiciousParams.length} suspicious parameters:`,
        `${byConfidence.high} high, ${byConfidence.medium} medium, ${byConfidence.low} low confidence.`,
      ].join(' ');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ suspiciousParams, summary }, null, 2) }],
      };
    },
  );
}
