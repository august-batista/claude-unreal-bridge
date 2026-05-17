#!/usr/bin/env node
/**
 * End-to-end verification for run-tests + read-logs against the sandbox.
 * Requires that the sandbox C++ has already been built (verify-build-cpp.js
 * succeeded). UE startup ~30-60s; tests themselves are tiny.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject } from "../dist/ue-bridge/project-detector.js";
import { runEditor } from "../dist/ue-bridge/editor-runner.js";
import { parseTestReport, formatTestReport } from "../dist/parsers/test-report.js";
import { filterLog, formatLogEntries } from "../dist/parsers/log-output.js";

const SANDBOX = "/Users/august/Documents/claude-unreal/sandbox-project";
const project = detectProject(SANDBOX);

console.log(`\n# run-tests against Sandbox.Sanity (positive only — should pass)`);
{
  const reportDir = mkdtempSync(join(tmpdir(), "claude-unreal-tests-"));
  const run = await runEditor(project, {
    extraArgs: [
      `-ExecCmds=Automation RunTests Sandbox.Sanity`,
      `-ReportExportPath=${reportDir}`,
      `-TestExit=Automation Test Queue Empty`,
      "-log",
    ],
    timeoutMs: 300_000,
    onSpawn: (_proc, kill) => {
      const reportPath = join(reportDir, "index.json");
      const interval = setInterval(() => {
        if (existsSync(reportPath)) {
          clearInterval(interval);
          setTimeout(() => kill(), 1500);
        }
      }, 500);
      return () => clearInterval(interval);
    },
  });
  console.log(`editor exit ${run.exitCode}, ${(run.durationMs/1000).toFixed(1)}s`);
  const reportPath = join(reportDir, "index.json");
  if (!existsSync(reportPath)) {
    console.log(`  ✗ no report at ${reportPath}`);
    console.log(`  stderr tail: ${run.stderr.slice(-1000)}`);
    process.exit(1);
  }
  const report = parseTestReport(JSON.parse(readFileSync(reportPath, "utf-8").replace(/^\uFEFF/, "")));
  console.log(formatTestReport(report));
  if (report.failed > 0) {
    console.log("✗ unexpected failures");
    process.exit(1);
  }
  if (report.succeeded === 0) {
    console.log("✗ no tests ran — filter may be wrong");
    process.exit(1);
  }
  rmSync(reportDir, { recursive: true, force: true });
}

console.log(`\n# run-tests against Sandbox.NegativeFixture (should fail)`);
{
  const reportDir = mkdtempSync(join(tmpdir(), "claude-unreal-tests-"));
  const reportPathPre = join(reportDir, "index.json");
  const run = await runEditor(project, {
    extraArgs: [
      `-ExecCmds=Automation RunTests Sandbox.NegativeFixture`,
      `-ReportExportPath=${reportDir}`,
      `-TestExit=Automation Test Queue Empty`,
      "-log",
    ],
    timeoutMs: 300_000,
    onSpawn: (_proc, kill) => {
      const interval = setInterval(() => {
        if (existsSync(reportPathPre)) {
          clearInterval(interval);
          setTimeout(() => kill(), 1500);
        }
      }, 500);
      return () => clearInterval(interval);
    },
  });
  console.log(`editor exit ${run.exitCode}, ${(run.durationMs/1000).toFixed(1)}s`);
  const reportPath = reportPathPre;
  if (!existsSync(reportPath)) {
    console.log(`  ✗ no report`);
    process.exit(1);
  }
  const report = parseTestReport(JSON.parse(readFileSync(reportPath, "utf-8").replace(/^\uFEFF/, "")));
  console.log(formatTestReport(report));
  if (report.failed === 0) {
    console.log("✗ expected at least one failure (NegativeFixture should fail)");
    process.exit(1);
  }
  // Verify the failing test carries an error event with the intentional message
  const fail = report.tests.find((t) => t.state === "Fail");
  if (!fail || fail.errors.length === 0) {
    console.log("✗ failing test has no error event captured");
    process.exit(1);
  }
  console.log(`✓ failing test "${fail.fullTestPath}" captured ${fail.errors.length} error event(s)`);
  rmSync(reportDir, { recursive: true, force: true });
}

console.log(`\n# read-logs after the runs above`);
{
  const logPath = join(project.projectPath, "Saved", "Logs", `${project.projectName}.log`);
  if (!existsSync(logPath)) {
    console.log(`✗ no log at ${logPath}`);
    process.exit(1);
  }
  const contents = readFileSync(logPath, "utf-8");
  const { entries, stats } = filterLog(contents, { minSeverity: "warning" }, 30);
  console.log(formatLogEntries(entries, stats, logPath));
  console.log(`\n✓ log filter found ${stats.matched} warnings/errors out of ${stats.parsedLines} parsed lines`);
}

console.log("\nAll runtime verifications passed.");
