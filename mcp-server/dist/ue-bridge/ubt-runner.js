import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { findBestInstallation, HOST_PLATFORM } from "./engine-locator.js";
import { parseCppBuildOutput } from "../parsers/cpp-build-output.js";
const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes — clean C++ builds can be slow
/**
 * Build a single UE C++ target via UnrealBuildTool.
 *
 * Wraps `Engine/Build/BatchFiles/<Platform>/Build.sh` (or .bat on Windows).
 * The default target — `<ProjectName>Editor` — is what you need before the
 * editor can open the project headlessly. If the project is Blueprint-only
 * (no Source/ folder), this is a no-op and returns success immediately.
 */
export async function buildCppTarget(project, options = {}) {
    const platform = options.platform ?? HOST_PLATFORM[process.platform] ?? "Mac";
    const configuration = options.configuration ?? "Development";
    const target = options.target ?? `${project.projectName}Editor`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Blueprint-only projects have no Source/ folder; nothing to build.
    if (!project.sourcePath || !existsSync(project.sourcePath)) {
        return {
            success: true,
            target,
            platform,
            configuration,
            errors: [],
            warnings: [],
            summary: "No Source/ folder — project is Blueprint-only, nothing to build.",
            exitCode: 0,
            durationMs: 0,
        };
    }
    const installation = findBestInstallation(project.engineVersion);
    if (!installation) {
        throw new Error(`No UE installation found for version ${project.engineVersion}`);
    }
    if (!existsSync(installation.buildScriptPath)) {
        throw new Error(`Build script not found at ${installation.buildScriptPath}. ` +
            `Engine install may be missing platform-specific build files.`);
    }
    const args = [
        target,
        platform,
        configuration,
        `-Project=${project.uprojectFile}`,
        "-WaitMutex",
        "-NoHotReload",
        ...(options.extraArgs ?? []),
    ];
    console.error(`[claude-unreal] UBT: ${installation.buildScriptPath}`);
    console.error(`[claude-unreal] UBT args: ${JSON.stringify(args)}`);
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const proc = spawn(installation.buildScriptPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 5000);
        }, timeoutMs);
        proc.on("close", (exitCode) => {
            clearTimeout(timer);
            const durationMs = Date.now() - startedAt;
            const fullOut = stdout + (timedOut ? `\n[claude-unreal] UBT timed out after ${timeoutMs}ms\n` : "");
            const fullErr = stderr;
            const parsed = parseCppBuildOutput(fullOut, fullErr, exitCode);
            resolve({
                ...parsed,
                target,
                platform,
                configuration,
                exitCode: timedOut ? null : exitCode,
                durationMs,
            });
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            const durationMs = Date.now() - startedAt;
            resolve({
                success: false,
                target,
                platform,
                configuration,
                errors: [
                    {
                        message: `Failed to spawn UBT: ${err.message}`,
                        severity: "error",
                        raw: err.message,
                    },
                ],
                warnings: [],
                summary: `Failed to launch UBT (${err.message}).`,
                exitCode: null,
                durationMs,
            });
        });
    });
}
//# sourceMappingURL=ubt-runner.js.map