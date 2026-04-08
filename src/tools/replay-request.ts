import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { TRUNCATE_LIMIT } from '../utils/truncate.js';

/** Headers that should not be forwarded when replaying a request. */
const STRIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

const REQUEST_TIMEOUT_MS = 30_000;

export function registerReplayRequest(server: McpServer): void {
  server.registerTool(
    'replay_request',
    {
      description: 'Replay a captured HTTP request with optional modifications',
      inputSchema: z.object({
        entryId: z.string().describe('The entry ID to replay'),
        headerOverrides: z
          .record(z.string())
          .optional()
          .describe('Headers to merge/replace on the outgoing request'),
        bodyOverrides: z
          .record(z.any())
          .optional()
          .describe('Fields to merge into the JSON request body'),
      }),
    },
    async (args) => {
      const db = getDb();

      const row = db.prepare(
        'SELECT method, url, requestHeaders, postDataText FROM entries WHERE id = ?'
      ).get(args.entryId) as
        | { method: string; url: string; requestHeaders: string | null; postDataText: string | null }
        | undefined;

      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Entry not found: ${args.entryId}` }) }],
          isError: true,
        };
      }

      // --- Build headers ---
      let headers: Record<string, string> = {};
      if (row.requestHeaders) {
        try {
          const parsed = JSON.parse(row.requestHeaders);
          if (Array.isArray(parsed)) {
            for (const h of parsed) {
              if (h && typeof h.name === 'string' && typeof h.value === 'string') {
                headers[h.name] = h.value;
              }
            }
          } else if (parsed && typeof parsed === 'object') {
            headers = { ...parsed };
          }
        } catch {
          // keep empty headers
        }
      }

      // Apply overrides
      if (args.headerOverrides) {
        Object.assign(headers, args.headerOverrides);
      }

      // Strip headers that shouldn't be forwarded
      for (const key of Object.keys(headers)) {
        if (STRIP_HEADERS.has(key.toLowerCase())) {
          delete headers[key];
        }
      }

      // Filter out HTTP/2 pseudo-headers
      for (const key of Object.keys(headers)) {
        if (key.startsWith(':')) {
          delete headers[key];
        }
      }

      // --- Build body ---
      let body: string | undefined;
      let warning: string | undefined;
      const rawBody = row.postDataText;

      if (rawBody != null) {
        if (args.bodyOverrides) {
          // Try to merge into JSON body
          try {
            const parsed = JSON.parse(rawBody);
            Object.assign(parsed, args.bodyOverrides);
            body = JSON.stringify(parsed);
          } catch {
            // Not JSON – send raw body as-is, warn about ignored overrides
            body = rawBody;
            warning = 'bodyOverrides ignored: request body is not JSON';
          }
        } else {
          body = rawBody;
        }
      }

      const method = row.method || 'GET';
      const url = row.url;

      // --- Send request with timeout ---
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const start = Date.now();

      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const timeTaken = Date.now() - start;

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        resp.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Read body, truncate using shared limit
        let responseBody = await resp.text();
        let truncated = false;
        if (responseBody.length > TRUNCATE_LIMIT) {
          responseBody = responseBody.slice(0, TRUNCATE_LIMIT);
          truncated = true;
        }

        const result: Record<string, unknown> = {
          status: resp.status,
          statusText: resp.statusText,
          responseHeaders,
          responseBody,
          timeTaken,
        };
        if (truncated) result._note = `Response body truncated to ${TRUNCATE_LIMIT} chars`;
        if (warning) result._warning = warning;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        clearTimeout(timeout);
        const timeTaken = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof Error && err.name === 'AbortError';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: isTimeout ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms` : `Fetch failed: ${message}`,
                timeTaken,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
