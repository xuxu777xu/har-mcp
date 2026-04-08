import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

type ExportFormat = 'curl' | 'python' | 'javascript' | 'httpie';

/** HTTP/2 pseudo-headers that should be excluded from all exports. */
function isPseudoHeader(name: string): boolean {
  return name.startsWith(':');
}

/** Parse requestHeaders JSON (array-of-objects or plain object) into a flat record. */
function parseHeaders(raw: string | null | undefined): Record<string, string> {
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const h of parsed) {
        if (h && typeof h.name === 'string' && typeof h.value === 'string') {
          out[h.name] = h.value;
        }
      }
      return out;
    }
    if (parsed && typeof parsed === 'object') {
      return { ...parsed };
    }
  } catch {
    // ignore
  }
  return {};
}

/** Escape a string for use inside single quotes in shell commands. */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Format generators
// ---------------------------------------------------------------------------

function generateCurl(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): string {
  const parts: string[] = [`curl -X ${method} '${shellEscape(url)}'`];

  for (const [name, value] of Object.entries(headers)) {
    parts.push(`  -H '${shellEscape(name)}: ${shellEscape(value)}'`);
  }

  if (body) {
    parts.push(`  -d '${shellEscape(body)}'`);
  }

  return parts.join(' \\\n');
}

function generatePython(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): string {
  const lines: string[] = ['import requests', ''];

  const headerEntries = Object.entries(headers);

  // Determine body kwarg
  let bodyKwarg = '';
  let parsedBody: unknown = null;
  if (body) {
    try {
      parsedBody = JSON.parse(body);
      bodyKwarg = `    json=${jsonToPython(parsedBody)},`;
    } catch {
      bodyKwarg = `    data='${body.replace(/'/g, "\\'")}',`;
    }
  }

  const methodLower = method.toLowerCase();

  lines.push(`response = requests.${methodLower}('${url}',`);

  if (headerEntries.length > 0) {
    lines.push('    headers={');
    for (const [name, value] of headerEntries) {
      lines.push(`        '${name}': '${value.replace(/'/g, "\\'")}',`);
    }
    lines.push('    },');
  }

  if (bodyKwarg) {
    lines.push(bodyKwarg);
  }

  lines.push(')');
  lines.push('print(response.status_code)');
  lines.push('print(response.text)');

  return lines.join('\n');
}

function generateJavascript(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): string {
  const lines: string[] = [];

  const opts: string[] = [];
  opts.push(`  method: '${method}',`);

  const headerEntries = Object.entries(headers);
  if (headerEntries.length > 0) {
    opts.push('  headers: {');
    for (const [name, value] of headerEntries) {
      opts.push(`    '${name}': '${value.replace(/'/g, "\\'")}',`);
    }
    opts.push('  },');
  }

  if (body) {
    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(body);
      opts.push(`  body: JSON.stringify(${JSON.stringify(parsedBody)}),`);
    } catch {
      opts.push(`  body: '${body.replace(/'/g, "\\'")}',`);
    }
  }

  lines.push(`const response = await fetch('${url}', {`);
  lines.push(...opts);
  lines.push('});');
  lines.push('const data = await response.text();');
  lines.push('console.log(response.status, data);');

  return lines.join('\n');
}

function generateHttpie(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): string {
  const parts: string[] = [`http ${method} ${url}`];

  for (const [name, value] of Object.entries(headers)) {
    parts.push(`  ${name}:${value}`);
  }

  // For JSON bodies, add key=value pairs
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') {
            parts.push(`  ${key}='${value}'`);
          } else {
            parts.push(`  ${key}:=${JSON.stringify(value)}`);
          }
        }
      }
    } catch {
      // Non-JSON body — not directly representable in httpie shorthand
      // Fall back to piped input note
      return `echo '${shellEscape(body)}' | ${parts.join(' \\\n')}`;
    }
  }

  return parts.join(' \\\n');
}

/** Minimal Python literal formatter for simple JSON values. */
function jsonToPython(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) {
    return `[${value.map(jsonToPython).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .map(([k, v]) => `'${k}': ${jsonToPython(v)}`)
      .join(', ');
    return `{${entries}}`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerExportRequest(server: McpServer): void {
  server.registerTool(
    'export_request',
    {
      description: 'Export a captured request as executable code',
      inputSchema: z.object({
        entryId: z.string().describe('The entry ID to export'),
        format: z
          .enum(['curl', 'python', 'javascript', 'httpie'])
          .describe('Output format'),
        headerOverrides: z
          .record(z.string())
          .optional()
          .describe('Headers to merge/replace before exporting'),
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

      // Build headers
      let headers = parseHeaders(row.requestHeaders as string | null);

      if (args.headerOverrides) {
        Object.assign(headers, args.headerOverrides);
      }

      // Filter out HTTP/2 pseudo-headers
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !isPseudoHeader(name)),
      );

      const method = (row.method as string) || 'GET';
      const url = row.url as string;
      const body = (row.postDataText as string) || null;

      const generators: Record<ExportFormat, () => string> = {
        curl: () => generateCurl(method, url, headers, body),
        python: () => generatePython(method, url, headers, body),
        javascript: () => generateJavascript(method, url, headers, body),
        httpie: () => generateHttpie(method, url, headers, body),
      };

      const code = generators[args.format as ExportFormat]();

      return {
        content: [{ type: 'text' as const, text: code }],
      };
    },
  );
}
