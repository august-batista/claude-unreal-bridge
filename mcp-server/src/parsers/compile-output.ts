import type {
  CompileResult,
  CompileMessage,
  CompileTotals,
} from "../types/ue-project.js";

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
export function parseCompileOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): CompileResult {
  const text = stdout + "\n" + stderr;
  const lines = text.split(/\r?\n/);

  const errors: CompileMessage[] = [];
  const warnings: CompileMessage[] = [];
  const seen = new Set<string>(); // dedupe (category|severity|message)

  // Categories the blueprint compile pipeline emits messages under.
  // LogBlueprint               — the BP system itself
  // LogK2Compiler              — node graph -> bytecode compilation
  // LogCompileAllBlueprintsCommandlet — the commandlet driver (summary, progress)
  // LogScriptCompile           — UE's general script compile (rare)
  const COMPILE_CATEGORIES =
    /^Log(Blueprint|K2Compiler|CompileAllBlueprintsCommandlet|ScriptCompile)\b/;

  // Match: "LogFoo: Error: [Asset /Game/X.X] message"
  //        "LogFoo: Warning: message"
  // Severity may be omitted (Display lines) — we only collect Error/Warning here.
  const messageLine = /^Log(\w+):\s+(Error|Warning):\s*(.*)$/;

  // Try to extract a blueprint asset path from the message body.
  // Common shapes:
  //   "[AssetLog] /Game/Path/BP_Foo.BP_Foo: ..."
  //   "Blueprint /Game/Path/BP_Foo failed to compile"
  //   "/Game/Path/BP_Foo.BP_Foo:..."
  const ASSET_PATH = /(\/Game\/[\w\-./]+?)(?:\.[A-Za-z_][\w]*)?(?=[:\s,'"\]]|$)/;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (!COMPILE_CATEGORIES.test(line)) continue;

    const m = line.match(messageLine);
    if (!m) continue;

    const category = `Log${m[1]}`;
    const severity = m[2].toLowerCase() as "error" | "warning";
    const message = m[3].trim();

    const dedupeKey = `${category}|${severity}|${message}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const assetMatch = message.match(ASSET_PATH);
    const blueprint = assetMatch ? assetMatch[1] : undefined;

    const entry: CompileMessage = {
      blueprint,
      category,
      message,
      severity,
      line,
    };

    if (severity === "error") errors.push(entry);
    else warnings.push(entry);
  }

  const totals = parseSummary(lines);

  // Trust the summary if we have one — it's the commandlet's own count.
  // Otherwise fall back to message-derived counts (won't include silent
  // failures, but better than nothing).
  const failedCount =
    totals?.failed ?? (errors.length > 0 ? errors.length : 0);
  const succeededCount = totals?.successful ?? null;

  const success = exitCode === 0 && failedCount === 0 && errors.length === 0;

  let summary: string;
  if (succeededCount !== null) {
    summary =
      `Compiled ${succeededCount} blueprint(s). ` +
      `${failedCount} failed, ${warnings.length} warning(s).`;
  } else if (success) {
    summary = "Compilation completed cleanly (no errors or warnings).";
  } else {
    summary =
      `Compilation reported ${errors.length} error(s) and ${warnings.length} warning(s)` +
      (exitCode !== null ? ` (exit ${exitCode}).` : ".");
  }

  return {
    success,
    errors,
    warnings,
    totals,
    summary,
    exitCode,
  };
}

/**
 * Pick the totals out of the commandlet's summary block, e.g.:
 *
 *   LogCompileAllBlueprintsCommandlet: Display: Total Successful Blueprints: 412
 *   LogCompileAllBlueprintsCommandlet: Display: Total Failed Blueprints: 2
 *   LogCompileAllBlueprintsCommandlet: Display: Failed Blueprint Names:
 *   LogCompileAllBlueprintsCommandlet: Display: BP_Foo
 *   LogCompileAllBlueprintsCommandlet: Display: BP_Bar
 */
function parseSummary(lines: string[]): CompileTotals | undefined {
  let successful: number | undefined;
  let failed: number | undefined;
  const failedNames: string[] = [];
  let inFailedNamesBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("LogCompileAllBlueprintsCommandlet")) {
      // Failed names block ends as soon as a non-commandlet line shows up
      // — the commandlet emits the names contiguously.
      inFailedNamesBlock = false;
      continue;
    }

    const successMatch = line.match(/Total Successful Blueprints:\s*(\d+)/i);
    if (successMatch) {
      successful = parseInt(successMatch[1], 10);
      inFailedNamesBlock = false;
      continue;
    }

    const failedMatch = line.match(/Total Failed Blueprints:\s*(\d+)/i);
    if (failedMatch) {
      failed = parseInt(failedMatch[1], 10);
      inFailedNamesBlock = false;
      continue;
    }

    if (/Failed Blueprint Names:\s*$/i.test(line)) {
      inFailedNamesBlock = true;
      continue;
    }

    if (inFailedNamesBlock) {
      // Lines look like:
      //   LogCompileAllBlueprintsCommandlet: Display: BP_Foo
      // or with a path:
      //   LogCompileAllBlueprintsCommandlet: Display: /Game/.../BP_Foo
      const nameMatch = line.match(
        /^LogCompileAllBlueprintsCommandlet:\s+(?:Display:\s+)?(.+)$/,
      );
      if (nameMatch) {
        const candidate = nameMatch[1].trim();
        // Stop if we hit another "Total ..." or "Failed ..." marker
        if (/^(Total|Failed)\b/i.test(candidate)) {
          inFailedNamesBlock = false;
          continue;
        }
        failedNames.push(candidate);
      }
    }
  }

  if (successful === undefined && failed === undefined) return undefined;

  return {
    successful: successful ?? 0,
    failed: failed ?? 0,
    failedBlueprints: failedNames.length > 0 ? failedNames : undefined,
  };
}

/**
 * Render compilation results as readable markdown.
 */
export function formatCompileResult(result: CompileResult): string {
  const lines: string[] = [];

  lines.push(
    result.success
      ? "## Compilation Result: SUCCESS"
      : "## Compilation Result: FAILED",
  );
  lines.push("", result.summary);

  if (result.totals?.failedBlueprints?.length) {
    lines.push("", "### Failed Blueprints", "");
    for (const name of result.totals.failedBlueprints) {
      lines.push(`- \`${name}\``);
    }
  }

  if (result.errors.length > 0) {
    lines.push("", `### Errors (${result.errors.length})`, "");
    for (const err of result.errors) {
      const bp = err.blueprint ? `\`${err.blueprint}\` — ` : "";
      lines.push(`- **[${err.category}]** ${bp}${err.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", `### Warnings (${result.warnings.length})`, "");
    for (const warn of result.warnings) {
      const bp = warn.blueprint ? `\`${warn.blueprint}\` — ` : "";
      lines.push(`- **[${warn.category}]** ${bp}${warn.message}`);
    }
  }

  return lines.join("\n");
}
