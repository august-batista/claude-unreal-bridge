import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import type { BlueprintSearchResult } from "../types/blueprint.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

export function registerSearchBlueprintsTool(server: McpServer): void {
  server.tool(
    "search-blueprints",
    "Search across all blueprints in a UE project for functions, variables, node types, or comment text.",
    {
      projectPath: z
        .string()
        .describe("Absolute path to the UE project directory"),
      query: z
        .string()
        .describe(
          "Search term: function name, variable name, node type, or comment text",
        ),
      scope: z
        .enum(["all", "functions", "variables", "nodes", "comments"])
        .default("all")
        .describe("Scope of the search"),
    },
    async ({ projectPath, query, scope }) => {
      try {
        const project = detectProject(projectPath);
        const scriptPath = join(pluginRoot, "python-scripts", "search_blueprints.py");

        const result = await runPythonInUE(project, scriptPath, {
          query,
          scope,
        });

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to search blueprints.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}`,
              },
            ],
          };
        }

        const results = result.data as BlueprintSearchResult[];
        const lines: string[] = [];

        if (results.length === 0) {
          lines.push(`No results found for "${query}" in ${scope} scope.`);
        } else {
          lines.push(`# Search Results for "${query}"`);
          lines.push(`Found matches in ${results.length} blueprint(s).`);
          lines.push("");

          for (const r of results) {
            lines.push(`## ${r.className} (\`${r.assetPath}\`)`);
            for (const m of r.matches) {
              lines.push(`- [${m.type}] **${m.name}**: ${m.context}`);
            }
            lines.push("");
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
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
