import type { CompileResult, CompileMessage } from "../types/ue-project.js";

/**
 * Format compilation results as readable markdown.
 */
export function formatCompileResult(result: CompileResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("## Compilation Result: SUCCESS");
  } else {
    lines.push("## Compilation Result: FAILED");
  }

  lines.push("", result.summary);

  if (result.errors.length > 0) {
    lines.push("", "### Errors", "");
    for (const err of result.errors) {
      const bp = err.blueprint ? `\`${err.blueprint}\`: ` : "";
      lines.push(`- ${bp}${err.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", "### Warnings", "");
    for (const warn of result.warnings) {
      const bp = warn.blueprint ? `\`${warn.blueprint}\`: ` : "";
      lines.push(`- ${bp}${warn.message}`);
    }
  }

  return lines.join("\n");
}
