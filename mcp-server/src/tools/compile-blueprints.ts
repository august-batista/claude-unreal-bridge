import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject } from "../ue-bridge/project-detector.js";
import { compileAllBlueprints } from "../ue-bridge/commandlet-runner.js";
import { formatCompileResult } from "../parsers/compile-output.js";

export function registerCompileBlueprintsTool(server: McpServer): void {
  server.tool(
    "compile-blueprints",
    "Compile all blueprints in a UE project and report errors/warnings. Uses the CompileAllBlueprints commandlet.",
    {
      projectPath: z
        .string()
        .describe("Absolute path to the UE project directory"),
      projectOnly: z
        .boolean()
        .default(true)
        .describe(
          "If true, only compile project blueprints (not engine/plugin blueprints)",
        ),
    },
    async ({ projectPath, projectOnly }) => {
      try {
        const project = detectProject(projectPath);
        const result = await compileAllBlueprints(project, projectOnly);
        const formatted = formatCompileResult(result);

        return {
          content: [{ type: "text" as const, text: formatted }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
