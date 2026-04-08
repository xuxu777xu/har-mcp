import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/connection.js';

const AUTH_HEADER_PATTERN = /auth|token|key|sign|bearer|cookie|csrf|session/i;
const RESPONSE_AUTH_HEADERS = ['set-cookie', 'www-authenticate', 'x-auth-token', 'x-csrf-token'];
const SIGNING_PARAM_PATTERN = /^(sign|signature|nonce|timestamp|token|key|hmac|secret|hash|digest|checksum|appkey|app_key|access_token|refresh_token)$/i;
const OAUTH_PATTERNS = [/authorize/i, /token/i, /callback|redirect/i];

interface TokenLifecycle {
  tokenKey: string;
  headerName: string;
  firstSeen: { entryId: string; url: string; time: string; location: 'request' | 'response' };
  lastSeen: { entryId: string; url: string; time: string };
  usageCount: number;
}

interface SigningParam {
  paramName: string;
  source: 'query' | 'body';
  sampleValues: string[];
  appearsInEndpoints: string[];
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

export function registerAnalyzeAuth(server: McpServer): void {
  server.registerTool(
    'analyze_auth',
    {
      description: 'Analyze authentication flows, token lifecycles, OAuth patterns, and signing parameters',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Filter by session ID'),
        domain: z.string().optional().describe('Filter by domain'),
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
        `SELECT id, method, url, urlPattern, startedDateTime,
                requestHeaders, responseHeaders, queryString, postDataText
         FROM entries ${whereClause}
         ORDER BY startedDateTime ASC
         LIMIT 500`
      ).all(...params) as Array<{
        id: string;
        method: string;
        url: string;
        urlPattern: string;
        startedDateTime: string;
        requestHeaders: string | null;
        responseHeaders: string | null;
        queryString: string | null;
        postDataText: string | null;
      }>;

      // --- Detect auth headers ---
      const authHeaderNames = new Set<string>();
      const tokenLifecycleMap = new Map<string, TokenLifecycle>();
      const signingParams: SigningParam[] = [];
      const signingParamMap = new Map<string, SigningParam>();

      for (const entry of entries) {
        // Scan request headers
        const reqHeaders = parseHeadersArray(entry.requestHeaders);
        for (const h of reqHeaders) {
          const lowerName = h.name.toLowerCase();
          if (AUTH_HEADER_PATTERN.test(lowerName) && lowerName !== 'content-type' && lowerName !== 'accept') {
            authHeaderNames.add(h.name);

            // Track token lifecycle
            const tokenKey = `${lowerName}:${h.value.slice(0, 32)}`;
            const existing = tokenLifecycleMap.get(tokenKey);
            if (existing) {
              existing.lastSeen = { entryId: entry.id, url: entry.url, time: entry.startedDateTime };
              existing.usageCount++;
            } else {
              tokenLifecycleMap.set(tokenKey, {
                tokenKey,
                headerName: h.name,
                firstSeen: { entryId: entry.id, url: entry.url, time: entry.startedDateTime, location: 'request' },
                lastSeen: { entryId: entry.id, url: entry.url, time: entry.startedDateTime },
                usageCount: 1,
              });
            }
          }
        }

        // Scan response headers
        const resHeaders = parseHeadersArray(entry.responseHeaders);
        for (const h of resHeaders) {
          const lowerName = h.name.toLowerCase();
          if (RESPONSE_AUTH_HEADERS.includes(lowerName) || AUTH_HEADER_PATTERN.test(lowerName)) {
            authHeaderNames.add(`${h.name} (response)`);

            if (lowerName === 'set-cookie' || lowerName.includes('token') || lowerName.includes('auth')) {
              const tokenKey = `resp:${lowerName}:${h.value.slice(0, 32)}`;
              if (!tokenLifecycleMap.has(tokenKey)) {
                tokenLifecycleMap.set(tokenKey, {
                  tokenKey,
                  headerName: h.name,
                  firstSeen: { entryId: entry.id, url: entry.url, time: entry.startedDateTime, location: 'response' },
                  lastSeen: { entryId: entry.id, url: entry.url, time: entry.startedDateTime },
                  usageCount: 1,
                });
              }
            }
          }
        }

        // Scan query params for signing patterns
        if (entry.queryString) {
          try {
            const qs = JSON.parse(entry.queryString) as Array<{ name: string; value: string }>;
            for (const p of qs) {
              if (SIGNING_PARAM_PATTERN.test(p.name)) {
                const key = `query:${p.name}`;
                const existing = signingParamMap.get(key);
                if (existing) {
                  if (existing.sampleValues.length < 5 && !existing.sampleValues.includes(p.value)) {
                    existing.sampleValues.push(p.value);
                  }
                  if (!existing.appearsInEndpoints.includes(entry.urlPattern)) {
                    existing.appearsInEndpoints.push(entry.urlPattern);
                  }
                } else {
                  const sp: SigningParam = {
                    paramName: p.name,
                    source: 'query',
                    sampleValues: [p.value],
                    appearsInEndpoints: [entry.urlPattern],
                  };
                  signingParamMap.set(key, sp);
                }
              }
            }
          } catch { /* skip */ }
        }

        // Scan body params for signing patterns
        if (entry.postDataText) {
          try {
            const body = JSON.parse(entry.postDataText);
            if (body && typeof body === 'object' && !Array.isArray(body)) {
              for (const [name, val] of Object.entries(body as Record<string, unknown>)) {
                if (SIGNING_PARAM_PATTERN.test(name)) {
                  const key = `body:${name}`;
                  const strVal = String(val);
                  const existing = signingParamMap.get(key);
                  if (existing) {
                    if (existing.sampleValues.length < 5 && !existing.sampleValues.includes(strVal)) {
                      existing.sampleValues.push(strVal);
                    }
                    if (!existing.appearsInEndpoints.includes(entry.urlPattern)) {
                      existing.appearsInEndpoints.push(entry.urlPattern);
                    }
                  } else {
                    signingParamMap.set(key, {
                      paramName: name,
                      source: 'body',
                      sampleValues: [strVal],
                      appearsInEndpoints: [entry.urlPattern],
                    });
                  }
                }
              }
            }
          } catch { /* not JSON */ }
        }
      }

      // --- Detect OAuth flows ---
      const oauthFlows: Array<{ pattern: string; entries: Array<{ entryId: string; url: string }> }> = [];
      const urlSequence = entries.map((e) => ({ id: e.id, url: e.url, urlLower: e.url.toLowerCase() }));

      for (let i = 0; i < urlSequence.length; i++) {
        if (OAUTH_PATTERNS[0].test(urlSequence[i].urlLower)) {
          // Found an authorize-like URL, look for token exchange nearby
          const flow: Array<{ entryId: string; url: string }> = [{ entryId: urlSequence[i].id, url: urlSequence[i].url }];
          for (let j = i + 1; j < Math.min(i + 15, urlSequence.length); j++) {
            if (OAUTH_PATTERNS[1].test(urlSequence[j].urlLower) || OAUTH_PATTERNS[2].test(urlSequence[j].urlLower)) {
              flow.push({ entryId: urlSequence[j].id, url: urlSequence[j].url });
            }
          }
          if (flow.length >= 2) {
            oauthFlows.push({ pattern: 'OAuth-like flow', entries: flow });
            i += 14; // skip ahead to avoid duplicate detection
          }
        }
      }

      // --- Build result ---
      const tokenLifecycles = Array.from(tokenLifecycleMap.values())
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, 30);

      for (const sp of signingParamMap.values()) {
        signingParams.push(sp);
      }

      const summary = [
        `Analyzed ${entries.length} requests.`,
        `Found ${authHeaderNames.size} auth-related header types.`,
        `Tracking ${tokenLifecycles.length} unique token values.`,
        `Found ${signingParams.length} signing-related parameters.`,
        `Detected ${oauthFlows.length} OAuth-like flow(s).`,
      ].join(' ');

      const result = {
        authHeaders: Array.from(authHeaderNames).sort(),
        tokenLifecycles,
        oauthFlows,
        signingParams,
        summary,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
