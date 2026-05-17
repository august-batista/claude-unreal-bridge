import type { CppBuildResult } from "../types/ue-project.js";
/**
 * Parse output from a UBT-driven C++ build.
 *
 * UBT prints compiler diagnostics from clang (Mac/Linux) or MSVC (Windows)
 * verbatim plus its own status lines. We pull error/warning records out of
 * the compiler output, then add UBT-level errors as a separate stream.
 *
 * Returned shape leaves `target`, `platform`, `configuration`, `exitCode`,
 * and `durationMs` unset — the caller (UBT runner) fills them in.
 */
export declare function parseCppBuildOutput(stdout: string, stderr: string, exitCode: number | null): Omit<CppBuildResult, "target" | "platform" | "configuration" | "exitCode" | "durationMs">;
/**
 * Render C++ build results as readable markdown.
 */
export declare function formatCppBuildResult(result: CppBuildResult): string;
//# sourceMappingURL=cpp-build-output.d.ts.map