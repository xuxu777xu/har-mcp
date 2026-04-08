# HAR MCP Server Design Spec

## Overview

A comprehensive HAR (HTTP Archive) analysis MCP server that enables AI-assisted reverse engineering of HTTP traffic. Supports dynamic loading of HAR files, SQL-powered querying, API analysis, flow reconstruction, request replay, and value tracing.

**Tech Stack:** TypeScript + Node.js + better-sqlite3
**Transport:** stdio (compatible with Claude Desktop and Claude Code)
**Target Scale:** <10 HAR files per project, individual files may be very large (up to 300MB+)

---

## Architecture

```
┌─────────────────────────────────────────────┐
│          Claude Desktop / Claude Code        │
│              (MCP Client)                    │
└──────────────┬──────────────────────────────┘
               │ MCP Protocol (stdio)
┌──────────────▼──────────────────────────────┐
│            HAR MCP Server                    │
│  ┌────────────┐  ┌──────────┐  ┌──────────┐ │
│  │  HAR Parser │  │ Query    │  │ Replay   │ │
│  │  (streaming)│  │ Engine   │  │ Engine   │ │
│  └─────┬──────┘  └────┬─────┘  └────┬─────┘ │
│        │              │             │        │
│  ┌─────▼──────────────▼─────────────▼─────┐  │
│  │         SQLite (better-sqlite3)        │  │
│  │  sessions / entries                    │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### Key Architectural Decisions

- **SQLite as cache layer:** All queries go through SQLite, no re-parsing of raw HAR files after initial load.
- **Streaming parse:** Large HAR files are parsed with `stream-json`, entries written in batches (500 per transaction) to avoid memory spikes.
- **Cache invalidation:** Based on `filePath + fileSize + fileMtime`. Cache stored in `.har-cache/` directory next to the HAR files.
- **Large body handling:** Response bodies exceeding 100KB are truncated in SQLite with size metadata; full content can be re-read from original HAR on demand.

---

## SQLite Schema

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,  -- UUID
  filePath      TEXT NOT NULL UNIQUE,
  fileName      TEXT NOT NULL,
  fileSize      INTEGER NOT NULL,
  fileMtime     TEXT NOT NULL,
  entryCount    INTEGER NOT NULL,
  domains       TEXT NOT NULL,     -- JSON array of unique domains
  timeRange     TEXT NOT NULL,     -- JSON { start, end }
  loadedAt      TEXT NOT NULL      -- ISO timestamp
);

CREATE TABLE entries (
  id                TEXT PRIMARY KEY,  -- UUID
  sessionId         TEXT NOT NULL REFERENCES sessions(id),
  startedDateTime   TEXT NOT NULL,
  time              REAL NOT NULL,     -- duration in ms

  -- Request
  method            TEXT NOT NULL,
  url               TEXT NOT NULL,
  domain            TEXT NOT NULL,
  path              TEXT NOT NULL,
  httpVersion       TEXT,
  queryString       TEXT,              -- JSON serialized
  requestHeaders    TEXT,              -- JSON serialized
  requestCookies    TEXT,              -- JSON serialized
  postDataMimeType  TEXT,
  postDataText      TEXT,

  -- Response
  status            INTEGER NOT NULL,
  statusText        TEXT,
  responseMimeType  TEXT,
  responseHeaders   TEXT,              -- JSON serialized
  responseBody      TEXT,              -- truncated if > 100KB
  responseBodyLength INTEGER,          -- actual full size
  responseSize      INTEGER,           -- transfer size

  -- Analysis helpers
  urlPattern        TEXT NOT NULL      -- normalized URL for aggregation
);

-- Indexes for common query patterns
CREATE INDEX idx_entries_session ON entries(sessionId);
CREATE INDEX idx_entries_domain ON entries(domain);
CREATE INDEX idx_entries_method ON entries(method);
CREATE INDEX idx_entries_status ON entries(status);
CREATE INDEX idx_entries_urlPattern ON entries(urlPattern);
CREATE INDEX idx_entries_time ON entries(startedDateTime);
```

### URL Normalization (urlPattern)

Path segments matching these patterns are replaced with `{id}`:
- Pure numeric: `/users/12345` -> `/users/{id}`
- UUID format: `/orders/a1b2c3d4-...` -> `/orders/{id}`
- Long random strings (>16 chars, alphanumeric): `/token/abc123def456ghi789` -> `/token/{id}`

---

## MCP Tools (12 total)

### Data Management

#### 1. `load_har`
Load and parse a HAR file into the SQLite cache.

- **Input:**
  - `filePath: string` — absolute or relative path to .har file
- **Behavior:**
  - Check cache validity (filePath + size + mtime match)
  - If valid cache exists, skip parsing and return cached summary
  - Otherwise, stream-parse the HAR file, write entries in batches of 500
- **Output:** `{ sessionId, fileName, entryCount, domains: string[], timeRange: { start, end }, cached: boolean }`

#### 2. `list_sessions`
List all loaded HAR sessions.

- **Input:** none
- **Output:** Array of session summaries (id, fileName, entryCount, domains, timeRange, loadedAt)

### Basic Query

#### 3. `query_entries`
Filter and search entries with flexible criteria.

- **Input:**
  - `sessionId?: string` — filter by session
  - `domain?: string` — exact domain match
  - `urlPattern?: string` — SQL LIKE pattern on URL
  - `method?: string` — GET/POST/etc
  - `statusCode?: number` — exact status code
  - `mimeType?: string` — response MIME type
  - `search?: string` — full-text search across URL and postDataText
  - `limit?: number` — default 50, max 200
  - `offset?: number` — for pagination
- **Output:** Array of entry summaries: `{ id, method, url, status, responseMimeType, responseSize, time, startedDateTime }`

#### 4. `get_entry_detail`
Get full details of a single request/response.

- **Input:**
  - `entryId: string`
- **Output:** Complete entry data including all headers, params, cookies, postData, and response body (truncated with size hint if >100KB)

#### 5. `search_bodies`
Full-text search across request/response bodies.

- **Input:**
  - `pattern: string` — search string (SQL LIKE)
  - `sessionId?: string`
  - `scope?: "request" | "response" | "both"` — default "both"
  - `limit?: number` — default 20
- **Output:** Array of `{ entryId, method, url, matchField, contextSnippet }` with surrounding text context

### Reverse Engineering Analysis

#### 6. `analyze_api`
Extract and summarize API endpoint patterns.

- **Input:**
  - `sessionId?: string`
  - `domain?: string`
  - `urlPattern?: string`
- **Output:** Array of API endpoints grouped by urlPattern:
  ```
  {
    urlPattern, methods: string[],
    requestParamKeys: string[],
    responseStructureSummary: string,  -- top-level keys and types
    authHeaders: string[],             -- detected auth-related headers
    sampleEntryIds: string[]           -- for deeper inspection
  }
  ```

#### 7. `analyze_flow`
Reconstruct business flow from request sequence.

- **Input:**
  - `sessionId?: string`
  - `domain?: string`
  - `timeRange?: { start: string, end: string }`
- **Output:**
  ```
  {
    steps: [{
      order, entryId, method, url, status, time,
      dependsOn?: entryId[],  -- detected data dependencies
      note?: string           -- e.g. "token obtained here"
    }],
    summary: string  -- high-level flow description
  }
  ```

#### 8. `trace_value`
Track a value's origin and propagation across requests.

- **Input:**
  - `value: string` — the value to trace (token, ID, etc.)
  - `sessionId?: string`
- **Output:**
  ```
  {
    occurrences: [{
      entryId, url, location: "requestHeader" | "requestBody" | "queryParam" | "responseHeader" | "responseBody",
      fieldName?: string,
      startedDateTime
    }],
    firstAppearance: { entryId, location, fieldName },
    propagationChain: string  -- human-readable summary
  }
  ```
  Results sorted by `startedDateTime` to show the value's lifecycle.

#### 9. `extract_params_schema`
Infer parameter schema by aggregating multiple requests to the same endpoint.

- **Input:**
  - `urlPattern: string` — normalized URL pattern to match
  - `sessionId?: string`
- **Output:**
  ```
  {
    urlPattern, sampleCount,
    queryParams: [{ name, type, required, exampleValues, enumValues? }],
    bodyParams: [{ name, type, required, exampleValues, enumValues? }],
    responseSchema: { topLevelKeys: [{ name, type }] }
  }
  ```

### Comparison

#### 10. `diff_requests`
Compare multiple requests to find static vs dynamic parameters.

- **Input:** (one of)
  - `entryIds: string[]` — 2+ specific entry IDs to compare
  - OR `urlPattern: string` + `sessionId?: string` — auto-select entries matching pattern
- **Output:**
  ```
  {
    staticParams: [{ name, value }],
    dynamicParams: [{ name, values: string[], pattern?: "increment" | "timestamp" | "random" | "signature" | "unknown" }],
    staticHeaders: [...],
    dynamicHeaders: [...]
  }
  ```

### Action

#### 11. `replay_request`
Replay a captured request with optional modifications.

- **Input:**
  - `entryId: string`
  - `headerOverrides?: Record<string, string>` — replace/add headers
  - `bodyOverrides?: Record<string, any>` — merge into request body (JSON only)
- **Behavior:** Send the request using Node.js native `fetch` with original headers/body, applying overrides
- **Output:** `{ status, statusText, responseHeaders, responseBody (truncated if large), timeTaken }`

#### 12. `export_request`
Export a request as executable code.

- **Input:**
  - `entryId: string`
  - `format: "curl" | "python" | "javascript" | "httpie"`
  - `headerOverrides?: Record<string, string>`
- **Output:** Code string ready to copy/paste and execute

---

## Project Structure

```
har_mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              -- MCP server entry point
│   ├── server.ts             -- MCP tool registration and dispatch
│   ├── db/
│   │   ├── schema.ts         -- SQLite schema init and migrations
│   │   └── connection.ts     -- SQLite connection management
│   ├── parser/
│   │   ├── stream-parser.ts  -- Streaming HAR parser
│   │   └── url-normalizer.ts -- URL pattern normalization
│   ├── tools/
│   │   ├── load-har.ts
│   │   ├── list-sessions.ts
│   │   ├── query-entries.ts
│   │   ├── get-entry-detail.ts
│   │   ├── search-bodies.ts
│   │   ├── analyze-api.ts
│   │   ├── analyze-flow.ts
│   │   ├── trace-value.ts
│   │   ├── extract-params-schema.ts
│   │   ├── diff-requests.ts
│   │   ├── replay-request.ts
│   │   └── export-request.ts
│   └── utils/
│       ├── cache.ts          -- Cache validity checking
│       └── truncate.ts       -- Body truncation helpers
├── har样本/                   -- Sample HAR files (gitignored)
└── .har-cache/               -- SQLite cache (gitignored)
```

---

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK
- `better-sqlite3` — Synchronous SQLite for Node.js
- `stream-json` — Streaming JSON parser for large HAR files
- `uuid` — Generate session/entry IDs

---

## Non-Goals (out of scope)

- HAR file editing or creation
- Web UI / visualization dashboard
- HAR file format validation or repair
- Websocket/SSE traffic analysis
- Automatic decryption of encrypted payloads
