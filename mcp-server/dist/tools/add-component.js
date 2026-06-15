import { z } from "zod";
import { join } from "node:path";
import { detectProject, normalizeToAssetPath } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";
const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();
export function registerAddComponentTool(server) {
    server.registerTool("add-component", {
        title: "Add Component",
        description: "Add a component to a Blueprint's component tree (the Components panel), then compile and save. " +
            "Pure Python — no ClaudeUnrealBridge plugin needed (uses the editor's SubobjectDataSubsystem, the same " +
            "API the Components panel uses). Attach under an existing component by name, or default to the root. " +
            "Use read-blueprint first to see existing component names. Destructive: modifies the .uasset (use git to roll back).",
        inputSchema: {
            projectPath: z.string().describe("Absolute path to the UE project directory"),
            blueprintPath: z
                .string()
                .describe("Asset path (e.g. /Game/Blueprints/BP_Player) or file path to the blueprint"),
            componentClass: z
                .string()
                .describe("Component class: a UE Python name (\"StaticMeshComponent\", \"SpringArmComponent\", \"CameraComponent\", " +
                "\"WidgetComponent\") or a class path (\"/Script/Engine.StaticMeshComponent\", \"/Game/BP/BPC_Foo.BPC_Foo_C\")."),
            componentName: z
                .string()
                .default("")
                .describe("Variable name for the new component (optional; the engine assigns a default if blank)."),
            parentComponent: z
                .string()
                .default("")
                .describe("Variable name of an existing component to attach under (optional; default = the root component)."),
            compile: z.boolean().default(true).describe("Compile the blueprint after adding the component (default true)."),
        },
        outputSchema: {
            success: z.boolean(),
            assetPath: z.string(),
            componentName: z.string(),
            componentClass: z.string(),
            parentComponent: z.string(),
            compiled: z.boolean().nullable(),
            saved: z.boolean(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, async ({ projectPath, blueprintPath, componentClass, componentName, parentComponent, compile }, extra) => {
        try {
            const project = detectProject(projectPath);
            const assetPath = normalizeToAssetPath(blueprintPath, project);
            const scriptPath = join(pluginRoot, "python-scripts", "add_component.py");
            const result = await runPythonInUE(project, scriptPath, {
                asset_path: assetPath,
                component_class: componentClass,
                component_name: componentName,
                parent_component: parentComponent,
                compile: String(compile),
            }, undefined, { signal: extra.signal, onProgress: progressFromExtra(extra) });
            if (!result.success || !result.data) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to add component.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}`,
                        },
                    ],
                };
            }
            const data = result.data;
            if (!data.success) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Add component failed: ${data.error ?? "unknown error"}` }],
                };
            }
            const where = data.parent_component ? ` under \`${data.parent_component}\`` : " at root";
            return {
                content: [
                    {
                        type: "text",
                        text: `Added \`${data.component_class}\` as \`${data.component_name}\`${where} on \`${data.asset_path}\`. Compiled: ${data.compiled ? "✓" : "—"}, saved: ${data.saved ? "✓" : "✗"}.`,
                    },
                ],
                structuredContent: {
                    success: data.success,
                    assetPath: data.asset_path,
                    componentName: data.component_name,
                    componentClass: data.component_class,
                    parentComponent: data.parent_component,
                    compiled: data.compiled ?? null,
                    saved: data.saved,
                },
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            };
        }
    });
}
//# sourceMappingURL=add-component.js.map