import { type ChildProcess } from "node:child_process";
import type { UEProject } from "../types/ue-project.js";
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
    onSpawn?: (proc: ChildProcess, kill: () => void) => void | (() => void);
}
export interface EditorRunResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
}
export declare function runEditor(project: UEProject, options: EditorRunOptions): Promise<EditorRunResult>;
//# sourceMappingURL=editor-runner.d.ts.map