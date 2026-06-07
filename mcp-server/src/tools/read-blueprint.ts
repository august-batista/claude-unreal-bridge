import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject, normalizeToAssetPath } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import {
  formatBlueprintAsMarkdown,
  validateBlueprintJson,
} from "../parsers/blueprint-json.js";
import { progressFromExtra } from "../mcp/progress.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

export function registerReadBlueprintTool(server: McpServer): void {
  server.registerTool(
    "read-blueprint",
    {
      title: "Read Blueprint",
      description:
        "Read a specific Unreal Engine blueprint and return its variables, functions, event graph logic, and components as structured text. Accepts asset paths (/Game/Blueprints/BP_Player) or file paths.",
      inputSchema: {
        projectPath: z
          .string()
          .describe("Absolute path to the UE project directory"),
        blueprintPath: z
          .string()
          .describe(
            "Asset path (e.g., /Game/Blueprints/BP_Player) or file path to the blueprint",
          ),
        detail: z
          .enum(["summary", "full", "graph-only"])
          .default("full")
          .describe(
            "Level of detail: summary (vars/funcs only), full (everything including graphs), graph-only (just node graphs)",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath, blueprintPath, detail }, extra) => {
      try {
        const project = detectProject(projectPath);
        const assetPath = normalizeToAssetPath(blueprintPath, project);
        const scriptPath = join(pluginRoot, "python-scripts", "extract_blueprint.py");

        const result = await runPythonInUE(
          project,
          scriptPath,
          { asset_path: assetPath },
          undefined,
          { signal: extra.signal, onProgress: progressFromExtra(extra) },
        );

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to read blueprint '${assetPath}'.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}\n\nCommon causes:\n- The asset path may be incorrect\n- The blueprint may have compilation errors\n- The UE editor may have failed to load the project`,
              },
            ],
          };
        }

        if (!validateBlueprintJson(result.data)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Blueprint data for '${assetPath}' was returned but has an unexpected format.\n\nRaw data: ${JSON.stringify(result.data, null, 2).substring(0, 2000)}`,
              },
            ],
          };
        }

        const markdown = formatBlueprintAsMarkdown(result.data, detail);

        return {
          content: [{ type: "text" as const, text: markdown }],
          // Full machine-readable graph: per-node nodeGuid + a `connections` edge list
          // (NodeGuid + pin name on both ends) on each event graph / function — directly
          // usable with edit-blueprint-graph's connect / breakPinLink. No strict outputSchema:
          // real blueprints vary too much in shape to validate without risking rejection.
          structuredContent: result.data as unknown as Record<string, unknown>,
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
