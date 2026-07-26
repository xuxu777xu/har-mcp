# har-mcp

**AI-powered HAR traffic analysis MCP server for reverse engineering HTTP APIs.**


---

<a id="english"></a>

## What is har-mcp?

har-mcp is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that turns HAR (HTTP Archive) files into a queryable database. It gives AI assistants like Claude the ability to load, search, analyze, and replay captured HTTP traffic — making API reverse engineering dramatically faster.

### Key Features

- **17 specialized tools** covering the full RE workflow: load, query, analyze, compare, replay, export
- **Stream parsing** for large HAR files (300MB+) without memory spikes
- **SQLite caching** — parse once, query many times
- **Multi-angle analysis** — API patterns, auth flows, encryption detection, timing, cookie tracking, business flow reconstruction
- **Request replay & export** — verify hypotheses and generate client code (curl / Python / JavaScript / HTTPie)

## Quick Start

### Install via npm (Recommended)

```bash
# No clone needed — just configure and use
claude mcp add -s user har-mcp -- npx -y @xuxu7777xu/har-mcp
```

### Install from source

```bash
git clone https://github.com/xuxu777xu/har-mcp.git
cd har-mcp
npm install && npm run build
claude mcp add -s user har-mcp -- node /path/to/har-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "har-mcp": {
      "command": "npx",
      "args": ["-y", "@xuxu7777xu/har-mcp"]
    }
  }
}
```

## Tools Reference

### Data Management

| Tool | Description |
|------|-------------|
| `load_har` | Load a HAR file into SQLite cache. Skips re-parsing if cache is valid. |
| `list_sessions` | List all loaded HAR sessions with summary info. |

### Basic Query

| Tool | Description |
|------|-------------|
| `query_entries` | Filter entries by domain, method, status, URL pattern, MIME type, or full-text search. |
| `get_entry_detail` | Get complete request/response details for a single entry. |
| `search_bodies` | Full-text search across request and response bodies. Supports regex. |

### Reverse Engineering Analysis

| Tool | Description |
|------|-------------|
| `analyze_api` | Extract API endpoint patterns: methods, params, response structure, auth headers. |
| `analyze_flow` | Reconstruct business flow from request sequence with dependency detection. |
| `trace_value` | Track a value (token, ID, etc.) across all requests to find its origin and propagation. |
| `extract_params_schema` | Infer parameter schema by aggregating multiple requests to the same endpoint. |
| `diff_requests` | Compare requests to identify static vs dynamic parameters. |

### Security Analysis

| Tool | Description |
|------|-------------|
| `analyze_auth` | Analyze authentication flows, token lifecycles, OAuth patterns, and signing parameters. |
| `analyze_cookies` | Track cookie lifecycles: when set, when used, attributes, and classification. |
| `analyze_timing` | Request frequency, slow requests, concurrency, and polling/heartbeat detection. |
| `detect_encryption` | Detect encrypted/signed/hashed parameters by analyzing entropy, length, and naming patterns. |
| `decode_value` | Auto-detect and decode encoded values (Base64, JWT, URL-encoded, JSON, Unicode, Hex). Supports chained decoding. |

### Action

| Tool | Description |
|------|-------------|
| `replay_request` | Replay a captured request with optional header/body overrides. |
| `export_request` | Export a request as executable code: `curl`, `python`, `javascript`, or `httpie`. |

## Example Workflow

```
You: Load D:/captures/api-traffic.har and analyze the auth mechanism

Claude:
  1. load_har → 238 entries, 5 domains
  2. analyze_auth → Found JWT in Authorization header, 30min token lifecycle
  3. detect_encryption → request body uses AES-encrypted "encStr" + SM3 digest "digstStr"
  4. trace_value → token first appears in /auth/login response, propagates to all subsequent requests
  5. export_request → generates curl command for the login endpoint
```

## Tech Stack

| Component | Details |
|-----------|---------|
| Runtime | Node.js (ES2022) |
| Language | TypeScript 5.8 (strict) |
| MCP SDK | @modelcontextprotocol/sdk |
| Database | better-sqlite3 (in-process SQLite) |
| Streaming | stream-json |
| Validation | Zod |
| Transport | stdio |

## Design Decisions

- **Stream parsing**: HAR files are parsed as a stream, with entries batched into SQLite in groups of 500. This handles 300MB+ files without memory issues.
- **URL normalization**: Dynamic segments (numeric IDs, UUIDs, long random strings) are replaced with `{id}` for endpoint aggregation.
- **Cache validity**: Based on file path + size + mtime. No re-parsing if nothing changed.
- **Response truncation**: Bodies >100KB are truncated in the database. Original file can be re-read on demand.

## License

MIT

---
