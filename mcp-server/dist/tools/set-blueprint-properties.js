import { z } from "zod";
import { join } from "node:path";
import { detectProject, normalizeToAssetPath } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";
const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();
function isBatchResult(data) {
    return typeof data === "object" && data !== null && "results" in data;
}
function formatBatchResult(data, assetPath) {
    if (data.error && !data.results) {
        return `Failed to apply changes to ${assetPath}.\n\nError: ${data.error}`;
    }
    const results = data.results ?? [];
    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const lines = [
        `**Blueprint:** ${assetPath}`,
        `**Applied:** ${succeeded.length}/${results.length} changes`,
        `**Saved:** ${data.saved ? "Yes" : "No"}`,
    ];
    if (data.save_error) {
        lines.push(`**Save error:** ${data.save_error}`);
    }
    if (succeeded.length > 0) {
        lines.push("", "### Changes applied");
        for (const r of succeeded) {
            lines.push(`- **${r.component}** → **${r.property}**: ${r.old_value} → ${r.new_value}`);
        }
    }
    if (failed.length > 0) {
        lines.push("", "### Failed changes");
        for (const r of failed) {
            lines.push(`- **${r.component ?? "?"}** → **${r.property ?? "?"}**: ${r.error}`);
        }
    }
    return lines.join("\n");
}
export function registerSetBlueprintPropertiesTool(server) {
    server.registerTool("set-blueprint-properties", {
        title: "Set Blueprint Properties (batch)",
        description: "Set multiple properties on a blueprint in a single Unreal Engine session. More efficient than calling set-blueprint-property repeatedly when you need to change several values on the same blueprint.",
        inputSchema: {
            projectPath: z
                .string()
                .describe("Absolute path to the UE project directory"),
            blueprintPath: z
                .string()
                .describe("Asset path (e.g., /Game/Blueprints/BP_Player) or file path to the blueprint"),
            changes: z
                .array(z.object({
                componentClass: z
                    .string()
                    .optional()
                    .describe("UE component class name, e.g. CharacterMovementComponent. Omit to target the blueprint CDO."),
                propertyName: z
                    .string()
                    .describe("Property name, e.g. MaxWalkSpeed"),
                value: z
                    .string()
                    .describe("New value as a string, e.g. \"1800\""),
            }))
                .min(1)
                .describe("List of property changes to apply"),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, async ({ projectPath, blueprintPath, changes }, extra) => {
        try {
            const project = detectProject(projectPath);
            const assetPath = normalizeToAssetPath(blueprintPath, project);
            const scriptPath = join(pluginRoot, "python-scripts", "set_blueprint_property.py");
            // Serialise changes to JSON for the Python script
            const changesPayload = changes.map((c) => ({
                component_class: c.componentClass ?? "",
                property_name: c.propertyName,
                property_value: c.value,
            }));
            const result = await runPythonInUE(project, scriptPath, {
                asset_path: assetPath,
                changes: JSON.stringify(changesPayload),
            }, undefined, { signal: extra.signal, onProgress: progressFromExtra(extra) });
            if (!result.success || !result.data) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to apply batch changes.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}`,
                        },
                    ],
                };
            }
            if (!isBatchResult(result.data)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Unexpected response format.\n\nRaw: ${JSON.stringify(result.data, null, 2).substring(0, 1000)}`,
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: formatBatchResult(result.data, assetPath),
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
}
//# sourceMappingURL=set-blueprint-properties.js.map