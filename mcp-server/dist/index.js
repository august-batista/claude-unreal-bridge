import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerListBlueprintsTool } from "./tools/list-blueprints.js";
import { registerReadBlueprintTool } from "./tools/read-blueprint.js";
import { registerSearchBlueprintsTool } from "./tools/search-blueprints.js";
import { registerCompileBlueprintsTool } from "./tools/compile-blueprints.js";
import { registerGenerateContextTool } from "./tools/generate-context.js";
import { registerReadAssetTool } from "./tools/read-asset.js";
import { registerSetBlueprintPropertyTool } from "./tools/set-blueprint-property.js";
import { registerSetBlueprintPropertiesTool } from "./tools/set-blueprint-properties.js";
import { registerListClassPropertiesTool } from "./tools/list-class-properties.js";
import { registerBuildCppTool } from "./tools/build-cpp.js";
import { registerReadLogsTool } from "./tools/read-logs.js";
import { registerRunTestsTool } from "./tools/run-tests.js";
import { registerRunScenarioTool } from "./tools/run-scenario.js";
const server = new McpServer({
    name: "claude-unreal",
    version: "0.2.0",
});
// Read / inspect
registerListBlueprintsTool(server);
registerReadBlueprintTool(server);
registerSearchBlueprintsTool(server);
registerGenerateContextTool(server);
registerReadAssetTool(server);
registerListClassPropertiesTool(server);
// Mutate
registerSetBlueprintPropertyTool(server);
registerSetBlueprintPropertiesTool(server);
// Build / compile
registerBuildCppTool(server);
registerCompileBlueprintsTool(server);
// Run / test / observe
registerRunTestsTool(server);
registerRunScenarioTool(server);
registerReadLogsTool(server);
const transport = new StdioServerTransport();
await server.connect(transport);
// Log to stderr (stdout is reserved for MCP JSON-RPC)
console.error("[claude-unreal] MCP server started");
//# sourceMappingURL=index.js.map