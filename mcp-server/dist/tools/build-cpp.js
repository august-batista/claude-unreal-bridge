import { z } from "zod";
import { detectProject } from "../ue-bridge/project-detector.js";
import { buildCppTarget } from "../ue-bridge/ubt-runner.js";
import { formatCppBuildResult } from "../parsers/cpp-build-output.js";
import { HOST_PLATFORM } from "../ue-bridge/engine-locator.js";
import { progressFromExtra } from "../mcp/progress.js";
import { cppBuildResultShape } from "../mcp/output-schemas.js";
export function registerBuildCppTool(server) {
    server.registerTool("build-cpp", {
        title: "Build C++ Target",
        description: "Build the project's C++ target via UnrealBuildTool. Required before the editor can open a project with stale C++ code. " +
            "Defaults to the editor target (`<ProjectName>Editor`), Development configuration, host platform. " +
            "Returns structured compile errors with file/line/column. No-op for Blueprint-only projects. " +
            "Streams per-translation-unit progress and can be cancelled.",
        inputSchema: {
            projectPath: z
                .string()
                .describe("Absolute path to the UE project directory"),
            target: z
                .string()
                .optional()
                .describe("UBT target name. Defaults to `<ProjectName>Editor`. Use the game target (e.g. `Sandbox`) to build for packaging."),
            platform: z
                .enum(["Mac", "Win64", "Linux"])
                .optional()
                .describe("Target platform. Defaults to the host platform. Cross-compilation requires the matching toolchain installed."),
            configuration: z
                .enum(["Debug", "DebugGame", "Development", "Shipping", "Test"])
                .default("Development")
                .describe("Build configuration. `Development` is the standard editor config; `DebugGame` for stepping through C++ in-editor."),
            timeoutMs: z
                .number()
                .int()
                .min(60_000)
                .max(3_600_000)
                .optional()
                .describe("Timeout in milliseconds. Defaults to 15 minutes — increase for clean builds of large projects."),
        },
        outputSchema: cppBuildResultShape,
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async ({ projectPath, target, platform, configuration, timeoutMs }, extra) => {
        try {
            const project = detectProject(projectPath);
            const result = await buildCppTarget(project, {
                target,
                platform: platform ?? HOST_PLATFORM[process.platform],
                configuration,
                timeoutMs,
                control: {
                    signal: extra.signal,
                    onProgress: progressFromExtra(extra),
                },
            });
            if (extra.signal?.aborted) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "C++ build cancelled." }],
                };
            }
            return {
                content: [
                    { type: "text", text: formatCppBuildResult(result) },
                ],
                // CppBuildResult is a closed interface; the SDK types structuredContent
                // as an open record. The shape is validated against cppBuildResultShape.
                structuredContent: result,
            };
        }
        catch (err) {
            return {
                isError: true,
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
//# sourceMappingURL=build-cpp.js.map