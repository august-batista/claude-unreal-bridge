import type { UEProject } from "../types/ue-project.js";
import { type RunControl } from "./run-control.js";
export type PythonErrorType = "timeout" | "spawn_failed" | "ue_load_failure" | "python_exception" | "no_output" | "unknown";
export interface PythonRunResult {
    success: boolean;
    data: unknown;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    errorType?: PythonErrorType;
    errorSummary?: string;
}
/**
 * Run a Python script inside the UE editor headlessly.
 *
 * The script receives the output file path as its first argument via
 * a wrapper that sets sys.argv. The script should write JSON to that file.
 */
export declare function runPythonInUE(project: UEProject, scriptPath: string, args?: Record<string, string>, timeoutMs?: number, control?: RunControl): Promise<PythonRunResult>;
//# sourceMappingURL=python-runner.d.ts.map