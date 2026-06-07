import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject, normalizeToAssetPath } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

interface SetPropertyResult {
  success: boolean;
  error?: string;
  asset_path?: string;
  component?: string;
  property?: string;
  snake_property?: string;
  old_value?: unknown;
  new_value?: unknown;
}

function isSetPropertyResult(data: unknown): data is SetPropertyResult {
  return typeof data === "object" && data !== null && "success" in data;
}

function formatResult(data: SetPropertyResult): string {
  if (!data.success) {
    return `Failed to set property.\n\nError: ${data.error}`;
  }

  const lines = [
    `**Blueprint:** ${data.asset_path}`,
    `**Component:** ${data.component}`,
    `**Property:** ${data.property}`,
    ``,
    `**Old value:** ${data.old_value}`,
    `**New value:** ${data.new_value}`,
    ``,
    `Blueprint saved successfully.`,
  ];

  return lines.join("\n");
}

export function registerSetBlueprintPropertyTool(server: McpServer): void {
  server.registerTool(
    "set-blueprint-property",
    {
      title: "Set Blueprint Property",
      description:
        "Set a property on a blueprint's component or on the blueprint itself (CDO). Use this to modify default values like MaxWalkSpeed on CharacterMovementComponent, jump velocity, gravity scale, etc. Changes are saved to the .uasset file.",
      inputSchema: {
        projectPath: z
          .string()
          .describe("Absolute path to the UE project directory"),
        blueprintPath: z
          .string()
          .describe(
            "Asset path (e.g., /Game/Blueprints/BP_Player) or file path to the blueprint",
          ),
        componentClass: z
          .string()
          .optional()
          .describe(
            "UE component class name to target, e.g. CharacterMovementComponent, ProjectileMovementComponent. Omit to set a property directly on the blueprint CDO.",
          ),
        propertyName: z
          .string()
          .describe(
            "Property name in PascalCase or snake_case, e.g. MaxWalkSpeed, JumpZVelocity, GravityScale",
          ),
        value: z
          .string()
          .describe(
            "New value as a string. Numerics, booleans (true/false), and strings are supported.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, blueprintPath, componentClass, propertyName, value }, extra) => {
      try {
        const project = detectProject(projectPath);
        const assetPath = normalizeToAssetPath(blueprintPath, project);
        const scriptPath = join(
          pluginRoot,
          "python-scripts",
          "set_blueprint_property.py",
        );

        const scriptArgs: Record<string, string> = {
          asset_path: assetPath,
          property_name: propertyName,
          property_value: value,
        };
        if (componentClass) {
          scriptArgs.component_class = componentClass;
        }

        const result = await runPythonInUE(project, scriptPath, scriptArgs, undefined, {
          signal: extra.signal,
          onProgress: progressFromExtra(extra),
        });

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to run set_blueprint_property.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}\n\nCommon causes:\n- The asset path may be incorrect\n- The UE editor may have failed to load the project`,
              },
            ],
          };
        }

        if (!isSetPropertyResult(result.data)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unexpected response format.\n\nRaw data: ${JSON.stringify(result.data, null, 2).substring(0, 2000)}`,
              },
            ],
          };
        }

        return {
          content: [{ type: "text" as const, text: formatResult(result.data) }],
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
