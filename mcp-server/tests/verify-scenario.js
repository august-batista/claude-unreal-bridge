#!/usr/bin/env node
/**
 * Smoke test for run-scenario: boot the default engine map with a Quit
 * exec command, confirm we capture logs from the run.
 *
 * Uses /Engine/Maps/Templates/OpenWorld (UE-bundled) so the sandbox
 * doesn't need to ship a Content/ asset.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProject } from "../dist/ue-bridge/project-detector.js";
import { runEditor } from "../dist/ue-bridge/editor-runner.js";
import { filterLog, formatLogEntries } from "../dist/parsers/log-output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(__dirname, "..", "..", "sandbox-project");
const project = detectProject(SANDBOX);

const logPath = join(project.projectPath, "Saved", "Logs", `${project.projectName}.log`);
const beforeMtime = existsSync(logPath) ? statSync(logPath).mtimeMs : 0;

console.log("# run-scenario boot OpenWorld map, Quit immediately");
const run = await runEditor(project, {
  extraArgs: [
    "-game",
    "/Engine/Maps/Templates/OpenWorld",
    `-ExecCmds=Quit`,
    "-log",
  ],
  timeoutMs: 180_000,
});

console.log(`editor exit ${run.exitCode}, ${(run.durationMs / 1000).toFixed(1)}s`);

if (!existsSync(logPath)) {
  console.log(`✗ log not produced at ${logPath}`);
  process.exit(1);
}
const afterMtime = statSync(logPath).mtimeMs;
if (afterMtime <= beforeMtime) {
  console.log(`✗ log not updated by this run (mtime didn't change)`);
  process.exit(1);
}
console.log(`✓ log updated by this run`);

const contents = readFileSync(logPath, "utf-8");
const { entries, stats } = filterLog(contents, {
  minSeverity: "warning",
}, 50);
console.log(formatLogEntries(entries, stats, logPath));
console.log(`\n✓ scenario log filter found ${stats.matched} signal lines out of ${stats.parsedLines} parsed`);
