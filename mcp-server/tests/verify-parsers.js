#!/usr/bin/env node
/**
 * Smoke-test the parsers against fixture data so regressions surface fast
 * (cheaper than burning a 10-minute UE startup for each iteration).
 *
 * Run: node tests/verify-parsers.js
 *
 * Treats each `assert(...)` failure as a test failure; exits non-zero on
 * any failure. Output is a TAP-ish summary.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCompileOutput } from "../dist/parsers/compile-output.js";
import { parseCppBuildOutput } from "../dist/parsers/cpp-build-output.js";
import { filterLog } from "../dist/parsers/log-output.js";
import { parseTestReport } from "../dist/parsers/test-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = (name) =>
  readFileSync(join(__dirname, "fixtures", name), "utf-8");

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push({ label, detail });
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) {
      console.log(`    ${JSON.stringify(detail)}`);
    }
  }
}

console.log("\n# parseCompileOutput — clean run");
{
  const out = parseCompileOutput(fixtures("compile-clean.txt"), "", 0);
  check("success=true", out.success === true, out);
  check("zero errors", out.errors.length === 0, out.errors);
  // The startup `LogStreaming: Warning:` line should NOT be counted.
  check(
    "startup warnings are not counted (only LogBlueprint/K2Compiler/CompileAllBlueprints)",
    out.warnings.length === 0,
    out.warnings,
  );
  check("totals.successful=2", out.totals?.successful === 2, out.totals);
  check("totals.failed=0", out.totals?.failed === 0, out.totals);
}

console.log("\n# parseCompileOutput — failure run");
{
  const out = parseCompileOutput(fixtures("compile-with-errors.txt"), "", 1);
  check("success=false", out.success === false, out);
  // 3 LogBlueprint/LogK2Compiler error lines, but two are duplicates -> 2 unique
  check("dedup'd errors == 2", out.errors.length === 2, out.errors.map((e) => e.message));
  check("warning count == 1", out.warnings.length === 1, out.warnings);
  check(
    "errors carry category",
    out.errors.every((e) => /^Log(Blueprint|K2Compiler)$/.test(e.category)),
    out.errors.map((e) => e.category),
  );
  check(
    "errors carry blueprint asset path",
    out.errors.every((e) => e.blueprint && e.blueprint.startsWith("/Game/")),
    out.errors.map((e) => e.blueprint),
  );
  check("totals.failed=2 from summary", out.totals?.failed === 2, out.totals);
  check(
    "totals.failedBlueprints includes BP_PlayerCharacter",
    out.totals?.failedBlueprints?.includes("BP_PlayerCharacter"),
    out.totals?.failedBlueprints,
  );
  check(
    "totals.failedBlueprints includes BP_GameMode",
    out.totals?.failedBlueprints?.includes("BP_GameMode"),
    out.totals?.failedBlueprints,
  );
}

console.log("\n# parseCppBuildOutput — clean build");
{
  const out = parseCppBuildOutput(fixtures("cpp-build-clean.txt"), "", 0);
  check("success=true", out.success === true, out);
  check("no errors", out.errors.length === 0, out.errors);
  check("no warnings", out.warnings.length === 0, out.warnings);
}

console.log("\n# parseCppBuildOutput — failing build");
{
  const out = parseCppBuildOutput(fixtures("cpp-build-fail.txt"), "", 1);
  check("success=false", out.success === false, out);
  // 2 clang errors (fatal + use of undeclared) + 1 UBT error (deduped to 1) = 3
  check("error count >= 3", out.errors.length >= 3, out.errors.map((e) => e.message));
  check(
    "errors include file:line for clang diagnostics",
    out.errors.some((e) => e.file && e.line),
    out.errors,
  );
  check(
    "warning detected with file:line",
    out.warnings.length === 1 &&
      out.warnings[0].file?.endsWith("SandboxSanityTest.cpp") &&
      out.warnings[0].line === 25,
    out.warnings,
  );
  check(
    "fatal-error severity is `error`",
    out.errors.find((e) => e.message.includes("file not found"))?.severity ===
      "error",
    out.errors,
  );
}

console.log("\n# parseCppBuildOutput — config-time UBT error (no compiler ran)");
{
  // Real captured output from a SandboxEditor target that mutates a setting
  // shared with UnrealEditor — the kind of failure that produces no clang
  // diagnostics, only prose + a "Result: Failed (OtherCompilationError)" line.
  const out = parseCppBuildOutput(fixtures("cpp-build-config-error.txt"), "", 6);
  check("success=false", out.success === false, out);
  check(
    "captures the prose explanation as an error",
    out.errors.some((e) =>
      e.message.includes("modifies the values of properties"),
    ),
    out.errors.map((e) => e.message),
  );
  check(
    "captures the Result: Failed marker",
    out.errors.some((e) => /UBT result: Failed.*OtherCompilationError/.test(e.message)),
    out.errors.map((e) => e.message),
  );
  check(
    "Upgrade warnings still surface",
    out.warnings.some((w) => w.message.startsWith("[Upgrade]")),
    out.warnings.map((w) => w.message),
  );
}

console.log("\n# filterLog");
{
  const sample = fixtures("log-sample.txt");

  // Default (warning+) catches both errors and warnings, not display/verbose.
  const def = filterLog(sample, { minSeverity: "warning" });
  check(
    "minSeverity=warning matches 3 lines (1 error + 2 warnings)",
    def.stats.matched === 3,
    def.entries.map((e) => `${e.severity}:${e.message}`),
  );
  check(
    "no verbose/display lines slipped through",
    def.entries.every(
      (e) => e.severity === "error" || e.severity === "warning",
    ),
    def.entries.map((e) => e.severity),
  );

  // Category filter
  const cat = filterLog(sample, {
    minSeverity: "warning",
    categories: ["LogBlueprint"],
  });
  check(
    "category=LogBlueprint matches 2 lines",
    cat.stats.matched === 2,
    cat.entries.map((e) => e.category),
  );

  // Pattern filter
  const pat = filterLog(sample, {
    minSeverity: "warning",
    pattern: "null",
  });
  check(
    "pattern=null matches just the null-ref error",
    pat.stats.matched === 1 && pat.entries[0].message.toLowerCase().includes("null"),
    pat.entries,
  );

  // Display floor includes everything except verbose/veryverbose
  // Fixture has 9 parseable lines; 1 is verbose, so 8 should match... but
  // lines without an explicit severity default to display, so the LogShutdown
  // line counts too — total 9.
  const disp = filterLog(sample, { minSeverity: "display" });
  check(
    "minSeverity=display matches 9 lines (drops only verbose)",
    disp.stats.matched === 9,
    disp.entries.map((e) => `${e.severity}:${e.message}`),
  );
  check(
    "verbose entry was filtered out",
    !disp.entries.some((e) => e.severity === "verbose"),
    disp.entries.map((e) => e.severity),
  );
}

console.log("\n# parseTestReport");
{
  const raw = JSON.parse(fixtures("test-report.json"));
  const r = parseTestReport(raw);
  check("succeeded=1", r.succeeded === 1, r);
  check("failed=1", r.failed === 1, r);
  check("2 tests parsed", r.tests.length === 2, r.tests);
  const failTest = r.tests.find((t) => t.state === "Fail");
  check("failing test has 1 error event", failTest?.errors.length === 1, failTest);
  check(
    "error event carries file & line",
    failTest?.errors[0].filename?.endsWith(".cpp") &&
      failTest?.errors[0].lineNumber === 35,
    failTest?.errors,
  );
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f.label}`);
  }
  process.exit(1);
}
