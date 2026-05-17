import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { findBestInstallation } from "./engine-locator.js";
import { parseCompileOutput } from "../parsers/compile-output.js";
import { defaultProjectLogPath } from "./project-detector.js";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes for compilation
/**
 * Run a UE commandlet against a project.
 */
export async function runCommandlet(project, commandlet, extraArgs = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
    const installation = findBestInstallation(project.engineVersion);
    if (!installation) {
        throw new Error(`No UE installation found for version ${project.engineVersion}`);
    }
    const editorCmd = installation.editorCmdPath;
    // Pin the log destination so `read-logs` can find compile output.
    const callerSetAbsLog = extraArgs.some((a) => /^-AbsLog=/i.test(a));
    const autoLog = [];
    if (!callerSetAbsLog) {
        const logPath = defaultProjectLogPath(project);
        try {
            mkdirSync(dirname(logPath), { recursive: true });
        }
        catch { /* may already exist */ }
        autoLog.push(`-AbsLog=${logPath}`);
    }
    const spawnArgs = [
        project.uprojectFile,
        `-Run=${commandlet}`,
        `-unattended`,
        `-nosplash`,
        `-nullrhi`,
        `-nosound`,
        `-nopause`,
        ...autoLog,
        ...extraArgs,
    ];
    // Debug: log the exact command being run to stderr
    console.error(`[claude-unreal] Spawning commandlet: ${editorCmd}`);
    console.error(`[claude-unreal] Args: ${JSON.stringify(spawnArgs)}`);
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const proc = spawn(editorCmd, spawnArgs, {
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
            if (timedOut) {
                resolve({
                    success: false,
                    stdout,
                    stderr: stderr +
                        `\n[claude-unreal] Commandlet timed out after ${timeoutMs}ms`,
                    exitCode: null,
                });
                return;
            }
            resolve({
                success: exitCode === 0,
                stdout,
                stderr,
                exitCode,
            });
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            resolve({
                success: false,
                stdout,
                stderr: stderr + `\n[claude-unreal] Failed to spawn: ${err.message}`,
                exitCode: null,
            });
        });
    });
}
/**
 * Run CompileAllBlueprints and parse the results.
 */
export async function compileAllBlueprints(project, projectOnly = true) {
    const args = projectOnly ? ["-ProjectOnly"] : [];
    const result = await runCommandlet(project, "CompileAllBlueprints", args);
    return parseCompileOutput(result.stdout, result.stderr, result.exitCode);
}
//# sourceMappingURL=commandlet-runner.js.map