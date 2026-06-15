import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

interface CreateAssetResult {
  success: boolean;
  asset_kind: string;
  asset_path: string;
  parent_class: string;
  saved: boolean;
  error?: string;
}

export function registerCreateAssetTool(server: McpServer): void {
  server.registerTool(
    "create-asset",
    {
      title: "Create Asset",
      description:
        "Create a new Blueprint or Widget Blueprint asset (empty shell) in the project's content, " +
        "with a chosen parent class. Pure Python — no ClaudeUnrealBridge plugin needed (uses the editor's " +
        "AssetTools + a Blueprint/Widget factory). Returns the new asset path; follow with " +
        "edit-blueprint-graph (logic + variables), add-component (components), or set-blueprint-property to " +
        "populate it. Destructive: writes a new .uasset to disk (use git to roll back).",
      inputSchema: {
        projectPath: z.string().describe("Absolute path to the UE project directory"),
        packagePath: z
          .string()
          .default("/Game")
          .describe("Content folder for the new asset, e.g. /Game/Blueprints. Created if missing."),
        assetName: z.string().describe("Name of the new asset, no extension (e.g. BP_Inventory)."),
        assetKind: z
          .enum(["blueprint", "widget"])
          .default("blueprint")
          .describe("blueprint = Actor/Object Blueprint; widget = Widget Blueprint (UMG)."),
        parentClass: z
          .string()
          .default("")
          .describe(
            "Parent class: a UE Python name (\"Actor\", \"Pawn\", \"ActorComponent\", \"UserWidget\") or a class path " +
              "(\"/Script/Engine.Actor\", \"/Game/BP/BP_Base.BP_Base_C\"). Default: Actor for blueprint, UserWidget for widget.",
          ),
      },
      outputSchema: {
        success: z.boolean(),
        assetPath: z.string(),
        assetKind: z.string(),
        parentClass: z.string(),
        saved: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, packagePath, assetName, assetKind, parentClass }, extra) => {
      try {
        const project = detectProject(projectPath);
        const scriptPath = join(pluginRoot, "python-scripts", "create_asset.py");

        const result = await runPythonInUE(
          project,
          scriptPath,
          {
            package_path: packagePath,
            asset_name: assetName,
            asset_kind: assetKind,
            parent_class: parentClass,
          },
          undefined,
          { signal: extra.signal, onProgress: progressFromExtra(extra) },
        );

        if (!result.success || !result.data) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Failed to create asset.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}`,
              },
            ],
          };
        }

        const data = result.data as CreateAssetResult;
        if (!data.success) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Create asset failed: ${data.error ?? "unknown error"}` }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Created ${data.asset_kind} \`${data.asset_path}\` (parent: ${data.parent_class || "?"})${data.saved ? ", saved" : " — NOT saved"}.`,
            },
          ],
          structuredContent: {
            success: data.success,
            assetPath: data.asset_path,
            assetKind: data.asset_kind,
            parentClass: data.parent_class,
            saved: data.saved,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
