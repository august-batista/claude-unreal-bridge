import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { UEProject } from "../types/ue-project.js";
import { findBestInstallation } from "./engine-locator.js";
import { defaultProjectLogPath } from "./project-detector.js";

/**
 * Generic launcher for `UnrealEditor-Cmd <Project> [extraArgs...]`.
 *
 * Used by run-tests, run-scenario, and anything else that needs to drive
 * the headless editor with a custom argv but doesn't fit the python-runner
 * pattern (no script wrapper, no JSON exchange).
 *
 * Always passes the standard headless flags: `-unattended -nopause -nullrhi
 * -nosound -nosplash`. Caller adds the rest.
 */

export interface EditorRunOptions {
  /** Extra argv to append after the project file. */
  extraArgs: string[];
  /** Timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override the standard headless flags (advanced; use sparingly). */
  headlessFlags?: string[];
  /**
   * Called immediately after the editor process spawns. Useful for
   * installing custom termination strategies — e.g. polling for a report
   * file and calling `kill()` once it appears (UE doesn't always
   * auto-quit after a queued exec command finishes).
   *
   * The returned function (if any) is invoked on process close to clean
   * up the watcher.
   */
  onSpawn?: (
    proc: ChildProcess,
    kill: () => void,
  ) => void | (() => void);
}

export interface EditorRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

const DEFAULT_HEADLESS = [
  "-unattended",
  "-nopause",
  "-nullrhi",
  "-nosound",
  "-nosplash",
];
const DEFAULT_TIMEOUT_MS = 300_000;

export async function runEditor(
  project: UEProject,
  options: EditorRunOptions,
): Promise<EditorRunResult> {
  const installation = findBestInstallation(project.engineVersion);
  if (!installation) {
    throw new Error(
      `No UE installation found for version ${project.engineVersion}`,
    );
  }

  const headless = options.headlessFlags ?? DEFAULT_HEADLESS;

  // Pin the log destination so `read-logs` finds it. UE on macOS otherwise
  // writes to ~/Library/Logs/Unreal Engine/<TargetName>/<Project>.log.
  // Caller-provided -AbsLog in extraArgs takes precedence (don't override).
  const callerSetAbsLog = options.extraArgs.some((a) =>
    /^-AbsLog=/i.test(a),
  );
  const autoLog: string[] = [];
  if (!callerSetAbsLog) {
    const logPath = defaultProjectLogPath(project);
    try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* may already exist */ }
    autoLog.push(`-AbsLog=${logPath}`);
  }

  const argv = [
    project.uprojectFile,
    ...headless,
    ...autoLog,
    ...options.extraArgs,
  ];

  console.error(`[claude-unreal] editor: ${installation.editorCmdPath}`);
  console.error(`[claude-unreal] editor argv: ${JSON.stringify(argv)}`);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<EditorRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(installation.editorCmdPath, argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });

    const kill = () => {
      try { proc.kill("SIGTERM"); } catch { /* may already be dead */ }
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* same */ }
      }, 5000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    let cleanupOnSpawn: (() => void) | void;
    if (options.onSpawn) {
      cleanupOnSpawn = options.onSpawn(proc, kill);
    }

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      if (typeof cleanupOnSpawn === "function") {
        try { cleanupOnSpawn(); } catch { /* best effort */ }
      }
      resolve({
        success: !timedOut && exitCode === 0,
        stdout,
        stderr,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (typeof cleanupOnSpawn === "function") {
        try { cleanupOnSpawn(); } catch { /* best effort */ }
      }
      resolve({
        success: false,
        stdout,
        stderr: stderr + `\n[claude-unreal] Failed to spawn: ${err.message}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
