import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "doyourweb-test-app", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "inspect", description: "Read a fixture value", inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "delay", inputSchema: { type: "object" } },
  { name: "client_version", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name === "delay") await new Promise(resolve => setTimeout(resolve, 1000));
  if (request.params.name === "client_version") return { content: [{ type: "text", text: server.getClientVersion().version }] };
  return { content: [{ type: "text", text: JSON.stringify(request.params.arguments || {}) }] };
});
await server.connect(new StdioServerTransport());
