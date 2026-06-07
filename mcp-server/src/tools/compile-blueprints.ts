import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject } from "../ue-bridge/project-detector.js";
import { compileAllBlueprints } from "../ue-bridge/commandlet-runner.js";
import { formatCompileResult } from "../parsers/compile-output.js";
import { progressFromExtra } from "../mcp/progress.js";
import { compileResultShape } from "../mcp/output-schemas.js";

export function registerCompileBlueprintsTool(server: McpServer): void {
  server.registerTool(
    "compile-blueprints",
    {
      title: "Compile Blueprints",
      description:
        "Compile all blueprints in a UE project and report errors/warnings. Uses the CompileAllBlueprints commandlet. " +
        "Returns structured results (per-blueprint failures, error/warning lists) alongside a readable summary.",
      inputSchema: {
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
      outputSchema: compileResultShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath, projectOnly }, extra) => {
      try {
        const project = detectProject(projectPath);
        const result = await compileAllBlueprints(project, projectOnly, {
          signal: extra.signal,
          onProgress: progressFromExtra(extra),
        });

        if (extra.signal?.aborted) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "Blueprint compilation cancelled." },
            ],
          };
        }

        return {
          content: [{ type: "text" as const, text: formatCompileResult(result) }],
          // CompileResult is a closed interface; the SDK types structuredContent
          // as an open record. The shape is validated against compileResultShape.
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          isError: true,
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
