import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  detectProject,
  normalizeToAssetPath,
  assetPathToFilePath,
} from "../ue-bridge/project-detector.js";

export function registerReadAssetTool(server: McpServer): void {
  server.tool(
    "read-asset",
    "Read basic metadata about any Unreal Engine asset. Returns file path, size, type, and related files (.uexp, .ubulk). For blueprint-specific data, use read-blueprint instead.",
    {
      projectPath: z
        .string()
        .describe("Absolute path to the UE project directory"),
      assetPath: z
        .string()
        .describe("Asset path or file path to the UE asset"),
    },
    async ({ projectPath, assetPath }) => {
      try {
        const project = detectProject(projectPath);
        const normalizedAssetPath = normalizeToAssetPath(assetPath, project);
        const filePath = assetPathToFilePath(normalizedAssetPath, project);

        const lines: string[] = [];
        lines.push(`# Asset: ${normalizedAssetPath}`);
        lines.push("");

        if (!existsSync(filePath)) {
          lines.push(`**Status:** File not found at \`${filePath}\``);
          lines.push(
            "",
            "The asset path may be incorrect. Use `list-blueprints` to find available assets.",
          );
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        }

        const stat = statSync(filePath);
        lines.push(`**File Path:** \`${filePath}\``);
        lines.push(`**Size:** ${formatBytes(stat.size)}`);
        lines.push(`**Modified:** ${stat.mtime.toISOString()}`);

        // Check for related files
        const basePath = filePath.replace(/\.uasset$/, "");
        const relatedFiles: string[] = [];
        for (const ext of [".uexp", ".ubulk"]) {
          const relatedPath = basePath + ext;
          if (existsSync(relatedPath)) {
            const relStat = statSync(relatedPath);
            relatedFiles.push(`${ext}: ${formatBytes(relStat.size)}`);
          }
        }

        if (relatedFiles.length > 0) {
          lines.push("");
          lines.push("**Related Files:**");
          for (const rf of relatedFiles) {
            lines.push(`- ${rf}`);
          }
        }

        lines.push("");
        lines.push(
          "*For detailed blueprint data (variables, functions, graphs), use the `read-blueprint` tool.*",
        );

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
