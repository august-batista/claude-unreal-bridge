import type {
  CppBuildResult,
  CppBuildMessage,
} from "../types/ue-project.js";

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
export function parseCppBuildOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): Omit<
  CppBuildResult,
  "target" | "platform" | "configuration" | "exitCode" | "durationMs"
> {
  const text = stdout + "\n" + stderr;
  const lines = text.split(/\r?\n/);

  const errors: CppBuildMessage[] = [];
  const warnings: CppBuildMessage[] = [];
  const seen = new Set<string>();

  // clang / gcc:  /path/to/file.cpp:42:5: error: 'foo' was not declared
  const clangRe =
    /^(.+?\.(?:cpp|h|hpp|inl|c|cc|mm|cxx)):(\d+):(?:(\d+):)?\s+(error|warning|note|fatal error):\s+(.*)$/i;
  // MSVC:  C:\path\file.cpp(42): error C2065: 'foo': undeclared identifier
  const msvcRe =
    /^(.+?\.(?:cpp|h|hpp|inl|c|cc|cxx))\((\d+)(?:,(\d+))?\):\s+(error|warning|fatal error)\s+([A-Z]\d+):\s+(.*)$/i;
  // UBT-level error lines (no file context):
  //   "ERROR: ..." or "Error: ..." (at start of line) or "BUILD FAILED"
  const ubtErrorRe = /^(ERROR|Error):\s+(.*)$/;
  const ubtWarnRe = /^(WARNING|Warning):\s+(.*)$/;
  // Final result line — UBT prints this exactly once when something goes
  // wrong before any compiler runs, e.g. "Result: Failed (OtherCompilationError)".
  // The reason in parens is the most useful single-line summary of the failure.
  const resultRe = /^Result:\s+(Failed|Error|Crashed)(?:\s+\((.+)\))?\s*$/i;

  // Track prose-style UBT diagnostics — lines without an "ERROR:" prefix
  // that show up after a "Wrote partial receipt" / "Creating makefile"
  // marker and before the "Result:" trailer. UBT uses these for config-time
  // failures (mismatched build environments, missing modules, etc.).
  let inProseSection = false;
  const proseLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    // Section markers that bound a prose-error window.
    if (
      /^(Wrote partial receipt|Creating makefile|Setting up bundled DotNet|Running dotnet|Log file:|Using 'git status')/.test(
        line,
      )
    ) {
      inProseSection = true;
      proseLines.length = 0; // reset — keep only the most recent block
      continue;
    }

    let match = line.match(clangRe);
    if (match) {
      const sev = match[4].toLowerCase();
      const severity: "error" | "warning" =
        sev === "warning" ? "warning" : "error";
      const entry: CppBuildMessage = {
        file: match[1],
        line: parseInt(match[2], 10),
        column: match[3] ? parseInt(match[3], 10) : undefined,
        message: match[5].trim(),
        severity,
        raw: line,
      };
      pushDedup(entry, errors, warnings, seen);
      inProseSection = false;
      continue;
    }

    match = line.match(msvcRe);
    if (match) {
      const sev = match[4].toLowerCase();
      const severity: "error" | "warning" =
        sev === "warning" ? "warning" : "error";
      const entry: CppBuildMessage = {
        file: match[1],
        line: parseInt(match[2], 10),
        column: match[3] ? parseInt(match[3], 10) : undefined,
        code: match[5],
        message: match[6].trim(),
        severity,
        raw: line,
      };
      pushDedup(entry, errors, warnings, seen);
      inProseSection = false;
      continue;
    }

    match = line.match(ubtErrorRe);
    if (match) {
      // Skip lines like "Error: 0 errors" that show up in UBT summaries.
      if (/^\s*\d+\s+errors?\b/i.test(match[2])) continue;
      pushDedup(
        {
          message: match[2].trim(),
          severity: "error",
          raw: line,
        },
        errors,
        warnings,
        seen,
      );
      continue;
    }

    match = line.match(ubtWarnRe);
    if (match) {
      pushDedup(
        {
          message: match[2].trim(),
          severity: "warning",
          raw: line,
        },
        errors,
        warnings,
        seen,
      );
      continue;
    }

    match = line.match(resultRe);
    if (match) {
      // Flush any prose lines we've been collecting as a single combined
      // error message — this is usually the actual diagnostic.
      if (proseLines.length > 0) {
        pushDedup(
          {
            message: proseLines.join(" "),
            severity: "error",
            raw: proseLines.join("\n"),
          },
          errors,
          warnings,
          seen,
        );
      }
      const reason = match[2] ? ` (${match[2]})` : "";
      pushDedup(
        {
          message: `UBT result: ${match[1]}${reason}`,
          severity: "error",
          raw: line,
        },
        errors,
        warnings,
        seen,
      );
      inProseSection = false;
      proseLines.length = 0;
      continue;
    }

    // Inside a prose window, collect non-noisy lines. We skip:
    // - "Total execution time:" trailers
    // - Pure dotnet/runtime status
    // - Lines we've already classified above
    if (inProseSection) {
      if (/^Total execution time:/i.test(line)) continue;
      if (line.length < 8) continue;
      proseLines.push(line);
    }
  }

  const success = exitCode === 0 && errors.length === 0;

  let summary: string;
  if (success) {
    summary = `Build succeeded${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`;
  } else if (exitCode === null) {
    summary = `Build did not complete (timed out or failed to launch). ${errors.length} error(s).`;
  } else {
    summary = `Build failed with ${errors.length} error(s) and ${warnings.length} warning(s) (exit ${exitCode}).`;
  }

  return { success, errors, warnings, summary };
}

function pushDedup(
  entry: CppBuildMessage,
  errors: CppBuildMessage[],
  warnings: CppBuildMessage[],
  seen: Set<string>,
): void {
  const key = `${entry.severity}|${entry.file ?? ""}|${entry.line ?? ""}|${entry.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (entry.severity === "error") errors.push(entry);
  else warnings.push(entry);
}

/**
 * Render C++ build results as readable markdown.
 */
export function formatCppBuildResult(result: CppBuildResult): string {
  const lines: string[] = [];
  lines.push(
    result.success
      ? `## C++ Build: SUCCESS — ${result.target} (${result.platform} ${result.configuration})`
      : `## C++ Build: FAILED — ${result.target} (${result.platform} ${result.configuration})`,
  );
  lines.push("", `${result.summary} (took ${formatMs(result.durationMs)})`);

  if (result.errors.length > 0) {
    lines.push("", `### Errors (${result.errors.length})`, "");
    for (const e of result.errors) {
      lines.push(`- ${formatMessage(e)}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", `### Warnings (${result.warnings.length})`, "");
    for (const w of result.warnings) {
      lines.push(`- ${formatMessage(w)}`);
    }
  }

  return lines.join("\n");
}

function formatMessage(m: CppBuildMessage): string {
  const loc = m.file
    ? `\`${m.file}${m.line ? `:${m.line}${m.column ? `:${m.column}` : ""}` : ""}\` — `
    : "";
  const code = m.code ? `[${m.code}] ` : "";
  return `${loc}${code}${m.message}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}
