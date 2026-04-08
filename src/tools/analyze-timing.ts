import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

interface FrequencyInfo {
  urlPattern: string;
  requestCount: number;
  avgIntervalMs: number | null;
  minIntervalMs: number | null;
  maxIntervalMs: number | null;
}

interface SlowRequest {
  entryId: string;
  method: string;
  url: string;
  time: number;
  startedDateTime: string;
}

interface PollingPattern {
  urlPattern: string;
  requestCount: number;
  avgIntervalMs: number;
  stdDevMs: number;
  detectedIntervalMs: number;
}

export function registerAnalyzeTiming(server: McpServer): void {
  server.registerTool(
    'analyze_timing',
    {
      description: 'Analyze request timing: frequency per endpoint, slow requests, concurrency, and polling/heartbeat detection',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Filter by session ID'),
        domain: z.string().optional().describe('Filter by domain'),
        slowThreshold: z.number().default(1000).optional()
          .describe('Threshold in ms for slow request detection (default: 1000)'),
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

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      const slowThreshold = args.slowThreshold ?? 1000;

      const entries = db.prepare(
        `SELECT id, method, url, urlPattern, startedDateTime, time
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC`
      ).all(...params) as Array<{
        id: string;
        method: string;
        url: string;
        urlPattern: string;
        startedDateTime: string;
        time: number;
      }>;

      // --- Frequency analysis ---
      const byEndpoint = new Map<string, Array<{ ts: number; entry: typeof entries[0] }>>();
      for (const entry of entries) {
        const ts = new Date(entry.startedDateTime).getTime();
        if (!byEndpoint.has(entry.urlPattern)) {
          byEndpoint.set(entry.urlPattern, []);
        }
        byEndpoint.get(entry.urlPattern)!.push({ ts, entry });
      }

      const frequencyByEndpoint: FrequencyInfo[] = [];
      const pollingPatterns: PollingPattern[] = [];

      for (const [pattern, items] of byEndpoint) {
        items.sort((a, b) => a.ts - b.ts);

        let avgInterval: number | null = null;
        let minInterval: number | null = null;
        let maxInterval: number | null = null;
        const intervals: number[] = [];

        if (items.length >= 2) {
          for (let i = 1; i < items.length; i++) {
            intervals.push(items[i].ts - items[i - 1].ts);
          }
          const sum = intervals.reduce((a, b) => a + b, 0);
          avgInterval = Math.round(sum / intervals.length);
          minInterval = Math.min(...intervals);
          maxInterval = Math.max(...intervals);
        }

        frequencyByEndpoint.push({
          urlPattern: pattern,
          requestCount: items.length,
          avgIntervalMs: avgInterval,
          minIntervalMs: minInterval,
          maxIntervalMs: maxInterval,
        });

        // Polling detection: 3+ requests with consistent intervals (stdDev/mean < 0.2)
        if (items.length >= 3 && intervals.length >= 2 && avgInterval !== null && avgInterval > 0) {
          const mean = avgInterval;
          const variance = intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
          const stdDev = Math.sqrt(variance);

          if (stdDev / mean < 0.2) {
            pollingPatterns.push({
              urlPattern: pattern,
              requestCount: items.length,
              avgIntervalMs: mean,
              stdDevMs: Math.round(stdDev),
              detectedIntervalMs: Math.round(mean / 1000) * 1000 || mean, // round to nearest second
            });
          }
        }
      }

      frequencyByEndpoint.sort((a, b) => b.requestCount - a.requestCount);

      // --- Slow requests ---
      const slowRequests: SlowRequest[] = entries
        .filter((e) => e.time > slowThreshold)
        .sort((a, b) => b.time - a.time)
        .slice(0, 20)
        .map((e) => ({
          entryId: e.id,
          method: e.method,
          url: e.url,
          time: e.time,
          startedDateTime: e.startedDateTime,
        }));

      // --- Concurrent request detection ---
      let maxConcurrency = 0;
      let maxConcurrentGroup: Array<{ entryId: string; url: string }> = [];

      // Sort by start time and use a sweep line approach
      const events: Array<{ ts: number; type: 'start' | 'end'; entryId: string; url: string }> = [];
      for (const entry of entries) {
        const startTs = new Date(entry.startedDateTime).getTime();
        const endTs = startTs + entry.time;
        events.push({ ts: startTs, type: 'start', entryId: entry.id, url: entry.url });
        events.push({ ts: endTs, type: 'end', entryId: entry.id, url: entry.url });
      }
      events.sort((a, b) => a.ts - b.ts || (a.type === 'end' ? -1 : 1));

      const active = new Map<string, string>();
      for (const ev of events) {
        if (ev.type === 'start') {
          active.set(ev.entryId, ev.url);
          if (active.size > maxConcurrency) {
            maxConcurrency = active.size;
            maxConcurrentGroup = Array.from(active.entries()).map(([id, url]) => ({
              entryId: id,
              url,
            }));
          }
        } else {
          active.delete(ev.entryId);
        }
      }

      const summary = [
        `Analyzed ${entries.length} requests across ${frequencyByEndpoint.length} endpoints.`,
        `${slowRequests.length} slow requests (>${slowThreshold}ms).`,
        `Max concurrency: ${maxConcurrency} simultaneous requests.`,
        `${pollingPatterns.length} polling/heartbeat pattern(s) detected.`,
      ].join(' ');

      const result = {
        frequencyByEndpoint: frequencyByEndpoint.slice(0, 50),
        slowRequests,
        maxConcurrency,
        maxConcurrentGroup: maxConcurrentGroup.slice(0, 10),
        pollingPatterns,
        summary,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
