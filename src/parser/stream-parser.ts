import streamJson from 'stream-json';
import Pick from 'stream-json/filters/Pick.js';
import StreamArray from 'stream-json/streamers/StreamArray.js';

const { parser } = streamJson;
const { pick } = Pick;
const { streamArray } = StreamArray;
import { pipeline } from 'stream/promises';
import { Writable } from 'stream';
import fs from 'fs';
import crypto from 'crypto';
import { getDb } from '../db/connection.js';
import { normalizeUrl } from './url-normalizer.js';
import { truncateBody } from '../utils/truncate.js';

interface ParseResult {
  entryCount: number;
  domains: string[];
  timeRange: { start: string; end: string };
}

const BATCH_SIZE = 500;

export async function parseHarFile(filePath: string, sessionId: string): Promise<ParseResult> {
  const db = getDb();

  const insertEntry = db.prepare(`
    INSERT INTO entries (
      id, sessionId, startedDateTime, time,
      method, url, domain, path, httpVersion,
      queryString, requestHeaders, requestCookies,
      postDataMimeType, postDataText,
      status, statusText, responseMimeType,
      responseHeaders, responseBody, responseBodyLength, responseSize,
      urlPattern,
      serverIPAddress, connection, comment, requestBodySize
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?
    )
  `);

  const domainSet = new Set<string>();
  let minTime = '';
  let maxTime = '';
  let entryCount = 0;
  let batch: unknown[][] = [];

  function flushBatch(): void {
    if (batch.length === 0) return;
    const tx = db.transaction((rows: unknown[][]) => {
      for (const row of rows) {
        insertEntry.run(...row);
      }
    });
    tx(batch);
    batch = [];
  }

  await pipeline(
    fs.createReadStream(filePath),
    parser(),
    pick({ filter: 'log.entries' }),
    streamArray(),
    new Writable({
      objectMode: true,
      write(chunk: { key: number; value: Record<string, unknown> }, _encoding, callback) {
        try {
          const entry = chunk.value as HarEntry;
          const id = crypto.randomUUID();
          const startedDateTime = entry.startedDateTime ?? '';
          const time = entry.time ?? 0;

          const req = entry.request ?? {} as HarRequest;
          const res = entry.response ?? {} as HarResponse;

          const method = req.method ?? 'GET';
          const url = req.url ?? '';
          const httpVersion = req.httpVersion ?? null;

          let domain = '';
          let pathname = '';
          try {
            const parsed = new URL(url);
            domain = parsed.hostname;
            pathname = parsed.pathname;
          } catch {
            domain = '';
            pathname = url;
          }

          if (domain) domainSet.add(domain);

          if (!minTime || startedDateTime < minTime) minTime = startedDateTime;
          if (!maxTime || startedDateTime > maxTime) maxTime = startedDateTime;

          const urlPattern = normalizeUrl(url);

          const queryString = req.queryString
            ? JSON.stringify(req.queryString)
            : null;
          const requestHeaders = req.headers
            ? JSON.stringify(req.headers)
            : null;
          const requestCookies = req.cookies
            ? JSON.stringify(req.cookies)
            : null;
          const postDataMimeType = req.postData?.mimeType ?? null;
          const postDataText = req.postData?.text ?? null;

          const status = res.status ?? 0;
          const statusText = res.statusText ?? '';
          const responseMimeType = res.content?.mimeType ?? null;
          const responseHeaders = res.headers
            ? JSON.stringify(res.headers)
            : null;

          const bodyResult = truncateBody(res.content?.text);
          const responseBody = bodyResult.text;
          const responseBodyLength = bodyResult.originalLength;
          const responseSize = res.content?.size ?? 0;

          const serverIPAddress = entry.serverIPAddress ?? null;
          const connection = entry.connection ?? null;
          const comment = entry.comment ?? null;
          const requestBodySize = req.bodySize ?? null;

          batch.push([
            id, sessionId, startedDateTime, time,
            method, url, domain, pathname, httpVersion,
            queryString, requestHeaders, requestCookies,
            postDataMimeType, postDataText,
            status, statusText, responseMimeType,
            responseHeaders, responseBody, responseBodyLength, responseSize,
            urlPattern,
            serverIPAddress, connection, comment, requestBodySize,
          ]);

          entryCount++;

          if (batch.length >= BATCH_SIZE) {
            flushBatch();
          }

          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    }),
  );

  // Flush remaining entries
  flushBatch();

  const domains = Array.from(domainSet).sort();
  const timeRange = { start: minTime, end: maxTime };

  // Update session with parsed metadata
  db.prepare(`
    UPDATE sessions SET entryCount = ?, domains = ?, timeRange = ? WHERE id = ?
  `).run(entryCount, JSON.stringify(domains), JSON.stringify(timeRange), sessionId);

  return { entryCount, domains, timeRange };
}

// -- HAR type helpers (minimal, for internal use) --

interface HarRequest {
  method?: string;
  url?: string;
  httpVersion?: string;
  headers?: unknown[];
  cookies?: unknown[];
  queryString?: unknown[];
  postData?: { mimeType?: string; text?: string };
  bodySize?: number;
}

interface HarResponse {
  status?: number;
  statusText?: string;
  headers?: unknown[];
  content?: { size?: number; mimeType?: string; text?: string };
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: HarRequest;
  response?: HarResponse;
  serverIPAddress?: string;
  connection?: string;
  comment?: string;
}
