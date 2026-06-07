import type { UEProject, CompileResult } from "../types/ue-project.js";
import { type RunControl } from "./run-control.js";
export interface CommandletResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}
/**
 * Run a UE commandlet against a project.
 */
export declare function runCommandlet(project: UEProject, commandlet: string, extraArgs?: string[], timeoutMs?: number, control?: RunControl): Promise<CommandletResult>;
/**
 * Run CompileAllBlueprints and parse the results.
 */
export declare function compileAllBlueprints(project: UEProject, projectOnly?: boolean, control?: RunControl): Promise<CompileResult>;
//# sourceMappingURL=commandlet-runner.d.ts.map