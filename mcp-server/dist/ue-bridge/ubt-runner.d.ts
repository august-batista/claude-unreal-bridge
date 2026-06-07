import type { UEProject, CppBuildResult, BuildConfiguration } from "../types/ue-project.js";
import { type RunControl } from "./run-control.js";
export interface BuildOptions {
    /** UBT target name. Defaults to `<ProjectName>Editor`. */
    target?: string;
    /** Platform name as UE expects (Mac, Win64, Linux). Defaults to host. */
    platform?: string;
    /** Build configuration. Defaults to "Development". */
    configuration?: BuildConfiguration;
    /** Timeout in ms. */
    timeoutMs?: number;
    /** Extra args to pass to UBT/Build.sh. */
    extraArgs?: string[];
    /** Cancellation + progress reporting. */
    control?: RunControl;
}
/**
 * Build a single UE C++ target via UnrealBuildTool.
 *
 * Wraps `Engine/Build/BatchFiles/<Platform>/Build.sh` (or .bat on Windows).
 * The default target — `<ProjectName>Editor` — is what you need before the
 * editor can open the project headlessly. If the project is Blueprint-only
 * (no Source/ folder), this is a no-op and returns success immediately.
 */
export declare function buildCppTarget(project: UEProject, options?: BuildOptions): Promise<CppBuildResult>;
//# sourceMappingURL=ubt-runner.d.ts.map