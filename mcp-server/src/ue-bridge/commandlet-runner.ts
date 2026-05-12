import { spawn } from "node:child_process";
import type { UEProject, CompileResult, CompileMessage } from "../types/ue-project.js";
import { findBestInstallation } from "./engine-locator.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes for compilation

export interface CommandletResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run a UE commandlet against a project.
 */
export async function runCommandlet(
  project: UEProject,
  commandlet: string,
  extraArgs: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandletResult> {
  const installation = findBestInstallation(project.engineVersion);
  if (!installation) {
    throw new Error(
      `No UE installation found for version ${project.engineVersion}`,
    );
  }

  const editorCmd = installation.editorCmdPath;
  const spawnArgs = [
    project.uprojectFile,
    `-Run=${commandlet}`,
    `-unattended`,
    `-nosplash`,
    `-nullrhi`,
    `-nosound`,
    `-nopause`,
    ...extraArgs,
  ];

  // Debug: log the exact command being run to stderr
  console.error(`[claude-unreal] Spawning commandlet: ${editorCmd}`);
  console.error(`[claude-unreal] Args: ${JSON.stringify(spawnArgs)}`);

  return new Promise<CommandletResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(editorCmd, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
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
          stderr:
            stderr +
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
export async function compileAllBlueprints(
  project: UEProject,
  projectOnly: boolean = true,
): Promise<CompileResult> {
  const args = projectOnly ? ["-ProjectOnly"] : [];
  const result = await runCommandlet(project, "CompileAllBlueprints", args);

  return parseCompileOutput(result);
}

function parseCompileOutput(result: CommandletResult): CompileResult {
  const errors: CompileMessage[] = [];
  const warnings: CompileMessage[] = [];
  const output = result.stdout + "\n" + result.stderr;

  const lines = output.split("\n");
  for (const line of lines) {
    // Match blueprint compilation errors
    // Typical format: "Error: [Blueprint /Game/Path/BP_Name] Description"
    const errorMatch = line.match(
      /Error:?\s*(?:\[(?:Blueprint\s+)?([^\]]+)\])?\s*(.*)/i,
    );
    if (errorMatch) {
      errors.push({
        blueprint: errorMatch[1] || undefined,
        message: errorMatch[2] || line,
        severity: "error",
        line: line.trim(),
      });
      continue;
    }

    // Match warnings
    const warnMatch = line.match(
      /Warning:?\s*(?:\[(?:Blueprint\s+)?([^\]]+)\])?\s*(.*)/i,
    );
    if (warnMatch) {
      warnings.push({
        blueprint: warnMatch[1] || undefined,
        message: warnMatch[2] || line,
        severity: "warning",
        line: line.trim(),
      });
    }
  }

  const totalIssues = errors.length + warnings.length;
  const summary = result.success
    ? totalIssues === 0
      ? "All blueprints compiled successfully with no errors or warnings."
      : `Compilation completed with ${errors.length} error(s) and ${warnings.length} warning(s).`
    : `Compilation failed with ${errors.length} error(s) and ${warnings.length} warning(s).`;

  return {
    success: result.success && errors.length === 0,
    errors,
    warnings,
    summary,
  };
}
