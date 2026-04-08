import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

/** Navigate an object by a simple dot/bracket path like "responseHeaders[0].value" */
function getByPath(obj: unknown, pathStr: string): unknown {
  const tokens = pathStr.match(/[^.[\]]+/g);
  if (!tokens) return undefined;

  let current: unknown = obj;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      const idx = /^\d+$/.test(token) ? Number(token) : token;
      current = (current as Record<string | number, unknown>)[idx];
    } else {
      return undefined;
    }
  }
  return current;
}

interface DecodeStep {
  step: string;
  input: string;
  output: string;
}

/** Try to decode a JWT (header.payload.signature) without verification. */
function tryJwtDecode(value: string): DecodeStep | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;

  // Each part must be valid Base64url
  const base64urlRegex = /^[A-Za-z0-9_-]+={0,2}$/;
  if (!base64urlRegex.test(parts[0]) || !base64urlRegex.test(parts[1])) return null;

  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));

    // Sanity check: JWT header typically has "alg"
    if (!header.alg && !header.typ) return null;

    return {
      step: 'JWT decode',
      input: value.length > 80 ? value.slice(0, 80) + '...' : value,
      output: JSON.stringify({ header, payload }, null, 2),
    };
  } catch {
    return null;
  }
}

/** Try Base64 decode. */
function tryBase64Decode(value: string): DecodeStep | null {
  // Must look like Base64: alphanumeric + /+ =, length >= 8, length multiple of 4 (after trimming whitespace)
  const trimmed = value.replace(/[\r\n\s]/g, '');
  if (trimmed.length < 8) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return null;
  if (trimmed.length % 4 !== 0) return null;

  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');

    // Verify it's reasonable UTF-8 (not too many control characters)
    let controlCount = 0;
    for (let i = 0; i < Math.min(decoded.length, 1000); i++) {
      const code = decoded.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlCount++;
    }
    const checkLen = Math.min(decoded.length, 1000);
    if (checkLen > 0 && controlCount / checkLen > 0.1) return null;

    // Must actually differ from input
    if (decoded === value) return null;

    return {
      step: 'Base64 decode',
      input: value.length > 80 ? value.slice(0, 80) + '...' : value,
      output: decoded,
    };
  } catch {
    return null;
  }
}

/** Try URL decode. */
function tryUrlDecode(value: string): DecodeStep | null {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return null;

  try {
    const decoded = decodeURIComponent(value);
    if (decoded === value) return null;

    return {
      step: 'URL decode',
      input: value.length > 80 ? value.slice(0, 80) + '...' : value,
      output: decoded,
    };
  } catch {
    return null;
  }
}

/** Try JSON parse and pretty-print. */
function tryJsonParse(value: string): DecodeStep | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty === trimmed) return null;

    return {
      step: 'JSON parse',
      input: value.length > 80 ? value.slice(0, 80) + '...' : value,
      output: pretty,
    };
  } catch {
    return null;
  }
}

/** Try Unicode unescape (\uXXXX patterns). */
function tryUnicodeUnescape(value: string): DecodeStep | null {
  if (!/\\u[0-9A-Fa-f]{4}/.test(value)) return null;

  const decoded = value.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );

  if (decoded === value) return null;

  return {
    step: 'Unicode unescape',
    input: value.length > 80 ? value.slice(0, 80) + '...' : value,
    output: decoded,
  };
}

/** Try Hex decode */
function tryHexDecode(value: string): DecodeStep | null {
  const trimmed = value.replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]+$/.test(trimmed)) return null;
  if (trimmed.length < 16 || trimmed.length % 2 !== 0) return null;

  try {
    const decoded = Buffer.from(trimmed, 'hex').toString('utf-8');
    let controlCount = 0;
    for (let i = 0; i < Math.min(decoded.length, 500); i++) {
      const code = decoded.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlCount++;
    }
    const checkLen = Math.min(decoded.length, 500);
    if (checkLen > 0 && controlCount / checkLen > 0.1) return null;
    if (decoded === value) return null;

    return {
      step: 'Hex decode',
      input: value.length > 80 ? value.slice(0, 80) + '...' : value,
      output: decoded,
    };
  } catch {
    return null;
  }
}

/** Run the decode chain: try each decoder, feed output into next round. */
function runDecodeChain(value: string, maxDepth = 5): DecodeStep[] {
  const steps: DecodeStep[] = [];
  let current = value;

  for (let depth = 0; depth < maxDepth; depth++) {
    // Try decoders in priority order
    const decoders = [tryJwtDecode, tryBase64Decode, tryUrlDecode, tryJsonParse, tryUnicodeUnescape, tryHexDecode];
    let decoded = false;

    for (const decoder of decoders) {
      const result = decoder(current);
      if (result) {
        steps.push(result);
        current = result.output;
        decoded = true;
        break;
      }
    }

    if (!decoded) break;
  }

  return steps;
}

export function registerDecodeValue(server: McpServer): void {
  server.registerTool(
    'decode_value',
    {
      description: 'Auto-detect and decode encoded values (Base64, JWT, URL-encoded, JSON, Unicode, Hex). Supports chained decoding.',
      inputSchema: z.object({
        entryId: z.string().optional().describe('Entry ID to extract value from'),
        fieldPath: z.string().optional().describe('Field path within the entry (e.g., "responseBody", "requestHeaders[0].value", "postDataText")'),
        rawValue: z.string().optional().describe('Raw value to decode directly (alternative to entryId+fieldPath)'),
      }),
    },
    async (args) => {
      let value: string;

      if (args.rawValue) {
        value = args.rawValue;
      } else if (args.entryId && args.fieldPath) {
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

        // Try to parse JSON fields for path navigation
        const obj: Record<string, unknown> = { ...row };
        for (const jsonField of ['requestHeaders', 'responseHeaders', 'queryString', 'requestCookies']) {
          if (typeof obj[jsonField] === 'string') {
            try { obj[jsonField] = JSON.parse(obj[jsonField] as string); } catch { /* keep raw */ }
          }
        }

        const extracted = getByPath(obj, args.fieldPath);
        if (extracted === undefined || extracted === null) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Field path "${args.fieldPath}" not found or null in entry ${args.entryId}` }),
            }],
            isError: true,
          };
        }

        value = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Provide either rawValue OR (entryId + fieldPath)' }),
          }],
          isError: true,
        };
      }

      const steps = runDecodeChain(value);

      const result = {
        originalValue: value.length > 200 ? value.slice(0, 200) + '...' : value,
        decodedSteps: steps,
        finalValue: steps.length > 0 ? steps[steps.length - 1].output : value,
        stepsCount: steps.length,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
