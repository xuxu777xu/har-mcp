import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLoadHar } from './tools/load-har.js';
import { registerListSessions } from './tools/list-sessions.js';
import { registerQueryEntries } from './tools/query-entries.js';
import { registerGetEntryDetail } from './tools/get-entry-detail.js';
import { registerSearchBodies } from './tools/search-bodies.js';
import { registerAnalyzeApi } from './tools/analyze-api.js';
import { registerAnalyzeFlow } from './tools/analyze-flow.js';
import { registerTraceValue } from './tools/trace-value.js';
import { registerExtractParamsSchema } from './tools/extract-params-schema.js';
import { registerDiffRequests } from './tools/diff-requests.js';
import { registerReplayRequest } from './tools/replay-request.js';
import { registerExportRequest } from './tools/export-request.js';
import { registerDecodeValue } from './tools/decode-value.js';
import { registerAnalyzeAuth } from './tools/analyze-auth.js';
import { registerAnalyzeCookies } from './tools/analyze-cookies.js';
import { registerAnalyzeTiming } from './tools/analyze-timing.js';
import { registerDetectEncryption } from './tools/detect-encryption.js';

export function registerAllTools(server: McpServer): void {
  registerLoadHar(server);
  registerListSessions(server);
  registerQueryEntries(server);
  registerGetEntryDetail(server);
  registerSearchBodies(server);
  registerAnalyzeApi(server);
  registerAnalyzeFlow(server);
  registerTraceValue(server);
  registerExtractParamsSchema(server);
  registerDiffRequests(server);
  registerReplayRequest(server);
  registerExportRequest(server);
  registerDecodeValue(server);
  registerAnalyzeAuth(server);
  registerAnalyzeCookies(server);
  registerAnalyzeTiming(server);
  registerDetectEncryption(server);
}
