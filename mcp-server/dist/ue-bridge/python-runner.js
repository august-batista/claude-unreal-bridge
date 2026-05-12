import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findBestInstallation } from "./engine-locator.js";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes (UE startup is slow)
/**
 * Classify the failure mode from UE's stderr output.
 * UE is noisy — this cuts through the noise to surface actionable causes.
 */
function classifyError(stderr, timedOut, spawnFailed) {
    if (spawnFailed)
        return "spawn_failed";
    if (timedOut)
        return "timeout";
    // Python traceback inside the UE process
    if (/Traceback \(most recent call last\)/i.test(stderr))
        return "python_exception";
    if (/LogPython: Error:/i.test(stderr))
        return "python_exception";
    // UE failed to load the project or critical module
    if (/Failed to load.*uproject/i.test(stderr))
        return "ue_load_failure";
    if (/Error.*PythonScriptPlugin/i.test(stderr))
        return "ue_load_failure";
    if (/couldn't find plugin/i.test(stderr))
        return "ue_load_failure";
    return "no_output";
}
/**
 * Extract the most actionable line(s) from raw stderr.
 * Avoids flooding the user with thousands of lines of UE startup log.
 */
function summariseError(stderr, errorType) {
    if (errorType === "timeout") {
        return "UE process did not complete within the timeout. This can happen on slow machines or if the project failed to load.";
    }
    if (errorType === "spawn_failed") {
        const m = stderr.match(/\[claude-unreal\] Failed to spawn: (.+)/);
        return m ? m[1] : "Failed to launch UnrealEditor-Cmd.";
    }
    if (errorType === "python_exception") {
        // Extract the traceback block
        const tbStart = stderr.search(/Traceback \(most recent call last\)/i);
        if (tbStart !== -1) {
            return stderr.slice(tbStart, tbStart + 2000).trim();
        }
        // Fall back to LogPython error lines
        const lines = stderr.split("\n").filter(l => /LogPython: Error:/i.test(l));
        return lines.slice(0, 10).join("\n") || stderr.slice(-500);
    }
    if (errorType === "ue_load_failure") {
        const lines = stderr.split("\n").filter(l => /error|failed|couldn't/i.test(l) && !/warning/i.test(l));
        return lines.slice(0, 5).join("\n") || "UE failed to load the project.";
    }
    // no_output / unknown: return last 500 chars of stderr as context
    return stderr.slice(-500).trim() || "No output produced and no recognisable error in stderr.";
}
/**
 * Run a Python script inside the UE editor headlessly.
 *
 * The script receives the output file path as its first argument via
 * a wrapper that sets sys.argv. The script should write JSON to that file.
 */
export async function runPythonInUE(project, scriptPath, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const installation = findBestInstallation(project.engineVersion);
    if (!installation) {
        throw new Error(`No UE installation found for version ${project.engineVersion}`);
    }
    // Create temp directory for output
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-unreal-"));
    const outputFile = join(tmpDir, "output.json");
    const argsFile = join(tmpDir, "args.json");
    // Write arguments to a JSON file the script can read
    const scriptArgs = {
        output_file: outputFile,
        project_path: project.projectPath,
        content_path: project.contentPath,
        ...args,
    };
    writeFileSync(argsFile, JSON.stringify(scriptArgs));
    // Create a wrapper script that sets up args and runs the actual script
    const wrapperScript = join(tmpDir, "wrapper.py");
    writeFileSync(wrapperScript, `
import json
import sys
import os

# Load arguments
args_file = r'${argsFile.replace(/\\/g, "\\\\")}'
with open(args_file, 'r') as f:
    _claude_args = json.load(f)

# Make args available globally
import builtins
builtins._claude_args = _claude_args

# Execute the actual script
script_path = r'${scriptPath.replace(/\\/g, "\\\\")}'
with open(script_path, 'r') as f:
    exec(f.read())
`);
    const editorCmd = installation.editorCmdPath;
    // Array-based spawn correctly handles spaces in paths at the OS level.
    // UE may print a harmless "Failed to find game directory" warning for
    // blueprint-only projects (no Binaries folder), but this doesn't affect operation.
    const spawnArgs = [
        project.uprojectFile,
        `-run=pythonscript`,
        `-script=${wrapperScript}`,
        `-unattended`,
        `-nosplash`,
        `-nullrhi`,
        `-nosound`,
        `-nopause`,
    ];
    // Debug: log the exact command being run to stderr
    console.error(`[claude-unreal] Spawning: ${editorCmd}`);
    console.error(`[claude-unreal] Args: ${JSON.stringify(spawnArgs)}`);
    console.error(`[claude-unreal] .uproject file exists: ${existsSync(project.uprojectFile)}`);
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let spawnFailed = false;
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
            // Try to read the output file
            let data = null;
            try {
                const content = readFileSync(outputFile, "utf-8");
                data = JSON.parse(content);
            }
            catch {
                // Output file doesn't exist or isn't valid JSON
            }
            // Clean up temp files
            try {
                unlinkSync(wrapperScript);
                unlinkSync(argsFile);
                try {
                    unlinkSync(outputFile);
                }
                catch {
                    /* may not exist */
                }
            }
            catch {
                /* best effort cleanup */
            }
            if (data !== null) {
                // Success is determined by whether the Python script produced output,
                // not the exit code. UE may print warnings to stderr (e.g., "Failed to
                // find game directory" for blueprint-only projects) while still working.
                resolve({ success: true, data, stdout, stderr, exitCode });
                return;
            }
            const errorType = classifyError(stderr, timedOut, spawnFailed);
            const errorSummary = summariseError(stderr, errorType);
            resolve({
                success: false,
                data: null,
                stdout,
                stderr,
                exitCode: timedOut ? null : exitCode,
                errorType,
                errorSummary,
            });
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            spawnFailed = true;
            const fullStderr = stderr + `\n[claude-unreal] Failed to spawn: ${err.message}`;
            resolve({
                success: false,
                data: null,
                stdout,
                stderr: fullStderr,
                exitCode: null,
                errorType: "spawn_failed",
                errorSummary: err.message,
            });
        });
    });
}
//# sourceMappingURL=python-runner.js.map