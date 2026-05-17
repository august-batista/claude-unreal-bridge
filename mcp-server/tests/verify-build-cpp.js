#!/usr/bin/env node
/**
 * End-to-end test: run buildCppTarget against the sandbox project.
 * Slow (~3-10 min on a clean build). Prints the parsed result.
 */
import { detectProject } from "../dist/ue-bridge/project-detector.js";
import { buildCppTarget } from "../dist/ue-bridge/ubt-runner.js";
import { formatCppBuildResult } from "../dist/parsers/cpp-build-output.js";

const SANDBOX = "/Users/august/Documents/claude-unreal/sandbox-project";

const project = detectProject(SANDBOX);
console.log(`Building ${project.projectName} editor target via UBT...`);
console.log(`Engine: UE ${project.engineVersion} @ ${project.enginePath}`);
console.log("(this can take several minutes on a cold build)\n");

const result = await buildCppTarget(project, {
  // Defaults: target = SandboxEditor, platform = Mac, config = Development
  timeoutMs: 1_200_000, // 20 min
});

console.log(formatCppBuildResult(result));
console.log(`\n--- raw result ---\n`);
console.log(JSON.stringify({
  success: result.success,
  exitCode: result.exitCode,
  durationMs: result.durationMs,
  errorCount: result.errors.length,
  warningCount: result.warnings.length,
}, null, 2));

if (!result.success) process.exit(1);
