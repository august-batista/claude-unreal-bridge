import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject } from "../ue-bridge/project-detector.js";
import { buildCppTarget } from "../ue-bridge/ubt-runner.js";
import { formatCppBuildResult } from "../parsers/cpp-build-output.js";
import { HOST_PLATFORM } from "../ue-bridge/engine-locator.js";

export function registerBuildCppTool(server: McpServer): void {
  server.tool(
    "build-cpp",
    "Build the project's C++ target via UnrealBuildTool. Required before the editor can open a project with stale C++ code. " +
      "Defaults to the editor target (`<ProjectName>Editor`), Development configuration, host platform. " +
      "Returns structured compile errors with file/line/column. No-op for Blueprint-only projects.",
    {
      projectPath: z
        .string()
        .describe("Absolute path to the UE project directory"),
      target: z
        .string()
        .optional()
        .describe(
          "UBT target name. Defaults to `<ProjectName>Editor`. Use the game target (e.g. `Sandbox`) to build for packaging.",
        ),
      platform: z
        .enum(["Mac", "Win64", "Linux"])
        .optional()
        .describe(
          "Target platform. Defaults to the host platform. Cross-compilation requires the matching toolchain installed.",
        ),
      configuration: z
        .enum(["Debug", "DebugGame", "Development", "Shipping", "Test"])
        .default("Development")
        .describe(
          "Build configuration. `Development` is the standard editor config; `DebugGame` for stepping through C++ in-editor.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(60_000)
        .max(3_600_000)
        .optional()
        .describe(
          "Timeout in milliseconds. Defaults to 15 minutes — increase for clean builds of large projects.",
        ),
    },
    async ({ projectPath, target, platform, configuration, timeoutMs }) => {
      try {
        const project = detectProject(projectPath);
        const result = await buildCppTarget(project, {
          target,
          platform: platform ?? HOST_PLATFORM[process.platform],
          configuration,
          timeoutMs,
        });
        return {
          content: [
            { type: "text" as const, text: formatCppBuildResult(result) },
          ],
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
