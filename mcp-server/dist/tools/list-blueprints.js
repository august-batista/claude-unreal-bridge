import { z } from "zod";
import { join } from "node:path";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();
export function registerListBlueprintsTool(server) {
    server.tool("list-blueprints", "List all blueprints in an Unreal Engine project. Returns asset paths, class names, parent classes, and types.", {
        projectPath: z
            .string()
            .describe("Absolute path to the UE project directory (containing .uproject file)"),
        filter: z
            .string()
            .optional()
            .describe("Optional filter: class name, path prefix, or parent class name"),
        type: z
            .enum(["all", "actor", "widget", "animation", "interface"])
            .default("all")
            .describe("Filter by blueprint type"),
    }, async ({ projectPath, filter, type }) => {
        try {
            const project = detectProject(projectPath);
            const scriptPath = join(pluginRoot, "python-scripts", "list_blueprints.py");
            const args = {};
            if (filter)
                args.filter = filter;
            if (type !== "all")
                args.type = type;
            const result = await runPythonInUE(project, scriptPath, args);
            if (!result.success || !result.data) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to list blueprints.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}\n\nMake sure the Unreal Engine editor can open this project headlessly.`,
                        },
                    ],
                };
            }
            const blueprints = result.data;
            const lines = [];
            lines.push(`# Blueprints in ${project.projectName}`);
            lines.push(`Found ${blueprints.length} blueprint(s).`);
            lines.push("");
            // Group by type
            const grouped = {};
            for (const bp of blueprints) {
                const key = bp.type || "Other";
                if (!grouped[key])
                    grouped[key] = [];
                grouped[key].push(bp);
            }
            for (const [typeName, bps] of Object.entries(grouped)) {
                lines.push(`## ${typeName} (${bps.length})`);
                lines.push("");
                for (const bp of bps) {
                    lines.push(`- \`${bp.assetPath}\` — ${bp.className} (extends ${bp.parentClass})`);
                }
                lines.push("");
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
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
//# sourceMappingURL=list-blueprints.js.map