import { z } from "zod";
import { join } from "node:path";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();
function isListPropertiesResult(data) {
    return (typeof data === "object" &&
        data !== null &&
        "class_name" in data &&
        "properties" in data &&
        Array.isArray(data.properties));
}
function formatResult(data) {
    if (data.error) {
        return `Failed to list properties for "${data.class_name}".\n\nError: ${data.error}`;
    }
    if (data.properties.length === 0) {
        return `No readable properties found on ${data.class_name}.`;
    }
    const lines = [
        `# Properties: ${data.class_name}`,
        ``,
        `${data.properties.length} properties found. Use these names with \`set-blueprint-property\`.`,
        ``,
        `| Property | Type | Default |`,
        `|----------|------|---------|`,
    ];
    for (const p of data.properties) {
        const defaultStr = p.default === null ? "null" : String(p.default);
        // Truncate long defaults (e.g. vector strings)
        const truncated = defaultStr.length > 60 ? defaultStr.slice(0, 57) + "..." : defaultStr;
        lines.push(`| ${p.name} | ${p.type} | ${truncated} |`);
    }
    return lines.join("\n");
}
export function registerListClassPropertiesTool(server) {
    server.tool("list-class-properties", "List all settable properties on a UE class (e.g. CharacterMovementComponent) with their names and default values. Use this to discover what property names to pass to set-blueprint-property.", {
        projectPath: z
            .string()
            .describe("Absolute path to the UE project directory"),
        className: z
            .string()
            .describe("UE C++ class name to inspect, e.g. CharacterMovementComponent, ProjectileMovementComponent, CameraComponent"),
    }, async ({ projectPath, className }) => {
        try {
            const project = detectProject(projectPath);
            const scriptPath = join(pluginRoot, "python-scripts", "list_class_properties.py");
            const result = await runPythonInUE(project, scriptPath, {
                class_name: className,
            });
            if (!result.success || !result.data) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to run list_class_properties.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}`,
                        },
                    ],
                };
            }
            if (!isListPropertiesResult(result.data)) {
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
                content: [{ type: "text", text: formatResult(result.data) }],
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
//# sourceMappingURL=list-class-properties.js.map