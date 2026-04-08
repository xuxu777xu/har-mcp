import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

interface CookieInfo {
  name: string;
  domain: string;
  firstSet: string | null;
  firstSetUrl: string | null;
  lastUsed: string | null;
  lastUsedUrl: string | null;
  setCount: number;
  useCount: number;
  values: string[];
  attributes: Record<string, string>;
  classification: 'session' | 'tracking' | 'auth' | 'other';
}

function classifyCookie(name: string): CookieInfo['classification'] {
  const lower = name.toLowerCase();
  if (/sess|sid|phpsessid|jsessionid|asp\.net_sessionid/.test(lower)) return 'session';
  if (/_ga|_gid|_gat|fbp|_fb|fbclid|_gcl|track|_pk_|_utm|_hjid|_dc_gtm/.test(lower)) return 'tracking';
  if (/auth|token|jwt|csrf|xsrf|bearer|access|refresh|login|remember/.test(lower)) return 'auth';
  return 'other';
}

/** Parse a Set-Cookie header value into name, value, and attributes. */
function parseSetCookie(headerValue: string): { name: string; value: string; attrs: Record<string, string> } | null {
  const parts = headerValue.split(';').map((s) => s.trim());
  if (parts.length === 0) return null;

  const firstPart = parts[0];
  const eqIdx = firstPart.indexOf('=');
  if (eqIdx < 1) return null;

  const name = firstPart.slice(0, eqIdx).trim();
  const value = firstPart.slice(eqIdx + 1).trim();
  const attrs: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const attrEq = parts[i].indexOf('=');
    if (attrEq > 0) {
      attrs[parts[i].slice(0, attrEq).trim().toLowerCase()] = parts[i].slice(attrEq + 1).trim();
    } else if (parts[i]) {
      attrs[parts[i].toLowerCase()] = 'true';
    }
  }

  return { name, value, attrs };
}

function parseHeadersArray(raw: string | null): Array<{ name: string; value: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((h) => h && typeof h.name === 'string' && typeof h.value === 'string');
    }
  } catch { /* skip */ }
  return [];
}

export function registerAnalyzeCookies(server: McpServer): void {
  server.registerTool(
    'analyze_cookies',
    {
      description: 'Track cookie lifecycles: when set, when used, attributes, and classification (session/tracking/auth)',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Filter by session ID'),
        domain: z.string().optional().describe('Filter by domain'),
        cookieName: z.string().optional().describe('Filter by specific cookie name'),
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

      const entries = db.prepare(
        `SELECT id, url, domain, startedDateTime, requestCookies, responseHeaders
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC
         LIMIT 1000`
      ).all(...params) as Array<{
        id: string;
        url: string;
        domain: string;
        startedDateTime: string;
        requestCookies: string | null;
        responseHeaders: string | null;
      }>;

      const cookieMap = new Map<string, CookieInfo>();

      function getOrCreate(name: string, domain: string): CookieInfo {
        const key = `${name}@${domain}`;
        let info = cookieMap.get(key);
        if (!info) {
          info = {
            name,
            domain,
            firstSet: null,
            firstSetUrl: null,
            lastUsed: null,
            lastUsedUrl: null,
            setCount: 0,
            useCount: 0,
            values: [],
            attributes: {},
            classification: classifyCookie(name),
          };
          cookieMap.set(key, info);
        }
        return info;
      }

      for (const entry of entries) {
        // Parse Set-Cookie from response headers
        const resHeaders = parseHeadersArray(entry.responseHeaders);
        for (const h of resHeaders) {
          if (h.name.toLowerCase() === 'set-cookie') {
            const parsed = parseSetCookie(h.value);
            if (!parsed) continue;
            if (args.cookieName && parsed.name !== args.cookieName) continue;

            const cookieDomain = parsed.attrs.domain ?? entry.domain;
            const info = getOrCreate(parsed.name, cookieDomain);
            info.setCount++;
            if (!info.firstSet) {
              info.firstSet = entry.startedDateTime;
              info.firstSetUrl = entry.url;
            }
            if (info.values.length < 5 && !info.values.includes(parsed.value)) {
              info.values.push(parsed.value.length > 50 ? parsed.value.slice(0, 50) + '...' : parsed.value);
            }
            // Merge attributes (last wins)
            Object.assign(info.attributes, parsed.attrs);
          }
        }

        // Parse request cookies
        if (entry.requestCookies) {
          try {
            const cookies = JSON.parse(entry.requestCookies) as Array<{ name: string; value: string }>;
            for (const c of cookies) {
              if (args.cookieName && c.name !== args.cookieName) continue;

              const info = getOrCreate(c.name, entry.domain);
              info.useCount++;
              info.lastUsed = entry.startedDateTime;
              info.lastUsedUrl = entry.url;
            }
          } catch { /* skip */ }
        }
      }

      const cookies = Array.from(cookieMap.values())
        .sort((a, b) => (b.setCount + b.useCount) - (a.setCount + a.useCount));

      const byClass = { session: 0, tracking: 0, auth: 0, other: 0 };
      for (const c of cookies) byClass[c.classification]++;

      const summary = [
        `Analyzed ${entries.length} requests.`,
        `Found ${cookies.length} unique cookies.`,
        `Classification: ${byClass.session} session, ${byClass.auth} auth, ${byClass.tracking} tracking, ${byClass.other} other.`,
      ].join(' ');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ cookies, summary }, null, 2) }],
      };
    },
  );
}
