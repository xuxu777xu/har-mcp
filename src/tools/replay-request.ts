import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

/** Headers that should not be forwarded when replaying a request. */
const STRIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

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

      const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(args.entryId) as
        | Record<string, unknown>
        | undefined;

      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Entry not found: ${args.entryId}` }) }],
          isError: true,
        };
      }

      // --- Build headers ---
      let headers: Record<string, string> = {};
      if (typeof row.requestHeaders === 'string') {
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
      const rawBody = row.postDataText as string | null;

      if (rawBody != null) {
        if (args.bodyOverrides) {
          // Try to merge into JSON body
          try {
            const parsed = JSON.parse(rawBody);
            Object.assign(parsed, args.bodyOverrides);
            body = JSON.stringify(parsed);
          } catch {
            // Not JSON – send raw body as-is
            body = rawBody;
          }
        } else {
          body = rawBody;
        }
      }

      const method = (row.method as string) || 'GET';
      const url = row.url as string;

      // --- Send request ---
      const start = Date.now();
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
        });

        const timeTaken = Date.now() - start;

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        resp.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Read body, truncate if > 50KB
        const MAX_BODY = 50 * 1024;
        let responseBody = await resp.text();
        let truncated = false;
        if (responseBody.length > MAX_BODY) {
          responseBody = responseBody.slice(0, MAX_BODY);
          truncated = true;
        }

        const result = {
          status: resp.status,
          statusText: resp.statusText,
          responseHeaders,
          responseBody,
          ...(truncated ? { _note: 'Response body truncated to 50KB' } : {}),
          timeTaken,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const timeTaken = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: `Fetch failed: ${message}`, timeTaken }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
