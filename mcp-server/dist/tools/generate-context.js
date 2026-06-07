import { z } from "zod";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";
import { scanProjectStructure, formatProjectOverview, } from "../parsers/project-structure.js";
const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();
export function registerGenerateContextTool(server) {
    server.registerTool("generate-context", {
        title: "Generate Project Context",
        description: "Generate a comprehensive UNREAL_CONTEXT.md file for a UE project, including project overview, blueprint inventory, and class hierarchy. Writes the file to disk.",
        inputSchema: {
            projectPath: z
                .string()
                .describe("Absolute path to the UE project directory"),
            outputPath: z
                .string()
                .optional()
                .describe("Where to write the context file. Defaults to UNREAL_CONTEXT.md in the project root."),
            sections: z
                .array(z.enum(["overview", "blueprints", "classes", "hierarchy"]))
                .default(["overview", "blueprints", "classes", "hierarchy"])
                .describe("Which sections to include"),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async ({ projectPath, outputPath, sections }, extra) => {
        try {
            const project = detectProject(projectPath);
            const onProgress = progressFromExtra(extra);
            const control = { signal: extra.signal, onProgress };
            const contextLines = [];
            // Project overview (filesystem-based, no UE needed)
            if (sections.includes("overview")) {
                const overview = scanProjectStructure(project);
                contextLines.push(formatProjectOverview(overview));
                contextLines.push("");
            }
            // Blueprint inventory (requires UE)
            let blueprints = null;
            if (sections.includes("blueprints")) {
                onProgress?.("Extracting blueprint inventory…");
                const listScript = join(pluginRoot, "python-scripts", "list_blueprints.py");
                const listResult = await runPythonInUE(project, listScript, {}, undefined, control);
                if (listResult.success && listResult.data) {
                    blueprints = listResult.data;
                    contextLines.push("## Blueprint Inventory");
                    contextLines.push("");
                    contextLines.push(`Total: ${blueprints.length} blueprint(s)`);
                    contextLines.push("");
                    // Group by directory
                    const byDir = {};
                    for (const bp of blueprints) {
                        const parts = bp.assetPath.split("/");
                        const dir = parts.slice(0, -1).join("/");
                        if (!byDir[dir])
                            byDir[dir] = [];
                        byDir[dir].push(bp);
                    }
                    for (const [dir, bps] of Object.entries(byDir).sort()) {
                        contextLines.push(`### ${dir}`);
                        for (const bp of bps) {
                            contextLines.push(`- **${bp.className}** — extends ${bp.parentClass} [${bp.type}]`);
                        }
                        contextLines.push("");
                    }
                }
                else {
                    contextLines.push("## Blueprint Inventory", "", "*Failed to extract blueprint list. Ensure UE can load the project headlessly.*", "");
                }
            }
            // Class hierarchy (requires UE)
            if (sections.includes("hierarchy")) {
                onProgress?.("Extracting class hierarchy…");
                const hierarchyScript = join(pluginRoot, "python-scripts", "extract_class_hierarchy.py");
                const hierarchyResult = await runPythonInUE(project, hierarchyScript, {}, undefined, control);
                if (hierarchyResult.success && hierarchyResult.data) {
                    const hierarchy = hierarchyResult.data;
                    contextLines.push("## Class Hierarchy");
                    contextLines.push("");
                    contextLines.push("```");
                    formatHierarchyTree(hierarchy, contextLines, 0);
                    contextLines.push("```");
                    contextLines.push("");
                }
                else {
                    contextLines.push("## Class Hierarchy", "", "*Failed to extract class hierarchy.*", "");
                }
            }
            const contextContent = contextLines.join("\n");
            // Write to file if output path specified
            const outFile = outputPath || join(project.projectPath, "UNREAL_CONTEXT.md");
            writeFileSync(outFile, contextContent, "utf-8");
            return {
                content: [
                    {
                        type: "text",
                        text: `Context file generated at: ${outFile}\n\n${contextContent}`,
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
function formatHierarchyTree(nodes, lines, indent) {
    for (const node of nodes) {
        const prefix = "  ".repeat(indent);
        const pathNote = node.assetPath ? ` (${node.assetPath})` : "";
        lines.push(`${prefix}${node.className}${pathNote}`);
        if (node.children.length > 0) {
            formatHierarchyTree(node.children, lines, indent + 1);
        }
    }
}
//# sourceMappingURL=generate-context.js.map