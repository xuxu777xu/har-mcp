# har-mcp

**AI-powered HAR traffic analysis MCP server for reverse engineering HTTP APIs.**

[English](#english) | [中文](#中文)

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

### Install

```bash
# Clone and build
git clone https://github.com/xuxu777xu/har-mcp.git
cd har-mcp
npm install
npm run build
```

### Add to Claude Code

```bash
# User-level (available in all projects)
claude mcp add -s user har-mcp -- node /path/to/har-mcp/dist/index.js

# Project-level
claude mcp add har-mcp -- node /path/to/har-mcp/dist/index.js
```

### Add to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "har-mcp": {
      "command": "node",
      "args": ["/path/to/har-mcp/dist/index.js"]
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

<a id="中文"></a>

## har-mcp 是什么？

har-mcp 是一个 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 服务器，能将 HAR 抓包文件转化为可查询的数据库，让 Claude 等 AI 助手具备加载、搜索、分析、重放 HTTP 流量的能力 —— 大幅提升 API 逆向工程效率。

### 核心特性

- **17 个专业工具**，覆盖完整的逆向工作流：加载、查询、分析、对比、重放、导出
- **流式解析**，支持 300MB+ 大型 HAR 文件，不会内存爆炸
- **SQLite 缓存** —— 解析一次，反复查询
- **多维度分析** —— API 模式、认证流程、加密检测、时序分析、Cookie 追踪、业务流重建
- **请求重放与导出** —— 验证逆向假设，一键生成客户端代码（curl / Python / JavaScript / HTTPie）

## 快速开始

### 安装

```bash
# 克隆并构建
git clone https://github.com/xuxu777xu/har-mcp.git
cd har-mcp
npm install
npm run build
```

### 添加到 Claude Code

```bash
# 用户级（所有项目可用）
claude mcp add -s user har-mcp -- node /path/to/har-mcp/dist/index.js

# 项目级
claude mcp add har-mcp -- node /path/to/har-mcp/dist/index.js
```

### 添加到 Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "har-mcp": {
      "command": "node",
      "args": ["/path/to/har-mcp/dist/index.js"]
    }
  }
}
```

## 工具一览

### 数据管理

| 工具 | 功能 |
|------|------|
| `load_har` | 加载 HAR 文件到 SQLite 缓存，缓存有效时自动跳过重复解析 |
| `list_sessions` | 列出所有已加载的 HAR 会话及摘要信息 |

### 基础查询

| 工具 | 功能 |
|------|------|
| `query_entries` | 按域名、方法、状态码、URL 模式、MIME 类型或全文搜索过滤请求 |
| `get_entry_detail` | 获取单条请求/响应的完整详情（头部、参数、Cookie、请求体、响应体） |
| `search_bodies` | 在请求体和响应体中全文搜索，支持正则表达式 |

### 逆向分析

| 工具 | 功能 |
|------|------|
| `analyze_api` | 提取 API 端点模式：支持的方法、参数键、响应结构、认证头 |
| `analyze_flow` | 从请求时序重建业务流程，自动检测数据依赖关系 |
| `trace_value` | 追踪某个值（token、ID 等）在所有请求中的来源和传播路径 |
| `extract_params_schema` | 聚合同一端点的多次请求，推断参数 schema（类型、是否必填、枚举值） |
| `diff_requests` | 对比多个请求，识别静态参数 vs 动态参数 |

### 安全分析

| 工具 | 功能 |
|------|------|
| `analyze_auth` | 分析认证流程、token 生命周期、OAuth 模式、签名参数 |
| `analyze_cookies` | 追踪 Cookie 生命周期：何时设置、何时使用、属性、分类（session/tracking/auth） |
| `analyze_timing` | 请求频率统计、慢请求检测、并发分析、轮询/心跳识别 |
| `detect_encryption` | 通过熵值、长度一致性、命名模式检测加密/签名/哈希参数 |
| `decode_value` | 自动识别并解码编码值（Base64、JWT、URL 编码、JSON、Unicode、Hex），支持链式解码 |

### 操作

| 工具 | 功能 |
|------|------|
| `replay_request` | 重放已捕获的请求，可覆盖 header 和 body |
| `export_request` | 将请求导出为可执行代码：`curl`、`python`、`javascript`、`httpie` |

## 使用示例

```
你：加载 D:/captures/api-traffic.har，分析一下认证机制

Claude：
  1. load_har → 238 条请求，5 个域名
  2. analyze_auth → 发现 Authorization 头中的 JWT，token 有效期 30 分钟
  3. detect_encryption → 请求体使用 AES 加密的 "encStr" + SM3 摘要 "digstStr"
  4. trace_value → token 首次出现在 /auth/login 响应中，随后传播到所有请求
  5. export_request → 生成登录接口的 curl 命令
```

## 技术栈

| 组件 | 详情 |
|------|------|
| 运行时 | Node.js (ES2022) |
| 语言 | TypeScript 5.8（严格模式） |
| MCP SDK | @modelcontextprotocol/sdk |
| 数据库 | better-sqlite3（进程内 SQLite） |
| 流式解析 | stream-json |
| 数据校验 | Zod |
| 传输协议 | stdio |

## 设计要点

- **流式解析**：HAR 文件以流的方式解析，每 500 条写入一个 SQLite 事务，300MB+ 文件也不会内存溢出
- **URL 规范化**：动态片段（数字 ID、UUID、长随机串）统一替换为 `{id}`，用于端点聚合
- **缓存策略**：基于文件路径 + 大小 + 修改时间判断缓存有效性，文件不变则不重复解析
- **响应截断**：超过 100KB 的响应体在数据库中截断存储，需要时可回读原始文件

## 许可证

MIT
