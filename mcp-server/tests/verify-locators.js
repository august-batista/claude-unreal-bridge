#!/usr/bin/env node
/**
 * Verify the engine locator and project detector against the real
 * sandbox project + installed UE_5.7. Cheap; no build/launch.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findUEInstallations, findBestInstallation, HOST_PLATFORM } from "../dist/ue-bridge/engine-locator.js";
import { detectProject } from "../dist/ue-bridge/project-detector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(__dirname, "..", "..", "sandbox-project");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
    if (detail) console.log("   ", JSON.stringify(detail));
  }
}

console.log("\n# engine locator");
{
  const all = findUEInstallations();
  check("found at least one UE installation", all.length >= 1, all);
  console.log("   installations:", all.map(i => `${i.version} @ ${i.path}`).join(", "));

  const best = findBestInstallation("5.7");
  check("found UE_5.7", best?.version === "5.7", best);
  check("editorCmdPath exists", !!best?.editorCmdPath, best);
  check("buildScriptPath exists", !!best?.buildScriptPath, best?.buildScriptPath);
  check("HOST_PLATFORM[darwin]=Mac", HOST_PLATFORM.darwin === "Mac");
}

console.log("\n# project detector against sandbox");
{
  const p = detectProject(SANDBOX);
  check("projectName=Sandbox", p.projectName === "Sandbox", p.projectName);
  check("uprojectFile resolved", p.uprojectFile.endsWith("Sandbox.uproject"), p.uprojectFile);
  check("engineVersion=5.7", p.engineVersion === "5.7", p.engineVersion);
  check("contentPath ends in /Content", p.contentPath.endsWith("/Content"), p.contentPath);
  check("sourcePath set (C++ project)", !!p.sourcePath, p.sourcePath);
  check("Sandbox module discovered", p.modules.includes("Sandbox"), p.modules);
  check("PythonScriptPlugin enabled", p.plugins.some(pl => pl.name === "PythonScriptPlugin" && pl.enabled), p.plugins);
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
