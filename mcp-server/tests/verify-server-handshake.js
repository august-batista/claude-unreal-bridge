#!/usr/bin/env node
/**
 * Boot the actual MCP server over stdio and verify it advertises everything
 * we registered: 13 tools (with annotations + output schemas where expected)
 * and 3 resources. Catches runtime registration failures that `tsc` can't —
 * e.g. an outputSchema the SDK rejects. Hermetic: no UE is launched (we only
 * initialize and list; we never call a tool).
 *
 * Run: node tests/verify-server-handshake.js
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const serverEntry = join(__dirname, "..", "dist", "index.js");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`    ${JSON.stringify(detail)}`);
  }
}

const proc = spawn("node", [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PLUGIN_ROOT: repoRoot },
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (b) => {
  buf += b.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "handshake-test", version: "0.0.0" },
  });
  check("initialize returns serverInfo", init.result?.serverInfo?.name === "claude-unreal", init.result?.serverInfo);
  check("server advertises tools capability", !!init.result?.capabilities?.tools, init.result?.capabilities);
  check("server advertises resources capability", !!init.result?.capabilities?.resources, init.result?.capabilities);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = (await request(2, "tools/list", {})).result?.tools ?? [];
  check("lists 17 tools", tools.length === 17, tools.map((t) => t.name));

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check(
    "read tools carry readOnlyHint",
    byName["list-blueprints"]?.annotations?.readOnlyHint === true &&
      byName["read-logs"]?.annotations?.readOnlyHint === true,
    byName["list-blueprints"]?.annotations,
  );
  check(
    "mutate tools carry destructiveHint",
    byName["set-blueprint-property"]?.annotations?.destructiveHint === true &&
      byName["edit-blueprint-graph"]?.annotations?.destructiveHint === true,
    byName["edit-blueprint-graph"]?.annotations,
  );
  for (const n of ["build-cpp", "compile-blueprints", "run-tests", "read-logs", "edit-blueprint-graph"]) {
    check(`${n} advertises an outputSchema`, !!byName[n]?.outputSchema, byName[n] && Object.keys(byName[n]));
  }
  check(
    "run-scenario is not flagged read-only",
    byName["run-scenario"]?.annotations?.readOnlyHint !== true,
    byName["run-scenario"]?.annotations,
  );

  const resources = (await request(3, "resources/list", {})).result?.resources ?? [];
  const ruris = resources.map((r) => r.uri).sort();
  check("lists 3 resources", resources.length === 3, ruris);
  check(
    "resources are info / log / context",
    ruris.join(",") ===
      ["unreal://project/context", "unreal://project/info", "unreal://project/log"].join(","),
    ruris,
  );
} catch (err) {
  fail++;
  console.log(`  ✗ handshake threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
