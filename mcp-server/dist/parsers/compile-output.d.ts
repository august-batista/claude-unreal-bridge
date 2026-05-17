import type { CompileResult } from "../types/ue-project.js";
/**
 * Parse the output of the CompileAllBlueprints commandlet.
 *
 * UE prints _many_ unrelated "Error:" / "Warning:" lines during editor
 * startup (asset loading, plugin discovery, mac framework noise). To stay
 * accurate, we only treat a line as a compile message when it is tagged
 * with one of the categories the blueprint compiler actually uses.
 *
 * The commandlet also emits an authoritative summary block. When present,
 * we use that for totals and the failed-blueprint list rather than trying
 * to reconstruct them from individual messages.
 */
export declare function parseCompileOutput(stdout: string, stderr: string, exitCode: number | null): CompileResult;
/**
 * Render compilation results as readable markdown.
 */
export declare function formatCompileResult(result: CompileResult): string;
//# sourceMappingURL=compile-output.d.ts.map