#!/usr/bin/env node
/**
 * Smoke-test the MCP primitives added on top of the tool layer:
 *   - output schemas actually validate real parser output (drift guard)
 *   - progressFromExtra emits monotonic notifications / no-ops without a token
 *   - run-control linkAbort + startHeartbeat behave
 *   - resources register and their read callbacks return well-formed contents
 *
 * Hermetic — no UE, no engine detection. Run: node tests/verify-mcp-primitives.js
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  compileResultShape,
  cppBuildResultShape,
  testRunStructuredShape,
  readLogsStructuredShape,
} from "../dist/mcp/output-schemas.js";
import { progressFromExtra } from "../dist/mcp/progress.js";
import { linkAbort, startHeartbeat } from "../dist/ue-bridge/run-control.js";
import { registerResources } from "../dist/mcp/resources.js";
import { clearCache } from "../dist/ue-bridge/project-detector.js";

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
    if (detail !== undefined) console.log(`    ${JSON.stringify(detail)}`);
  }
}

function validates(shape, value) {
  const res = z.object(shape).safeParse(value);
  return res.success ? { ok: true } : { ok: false, error: res.error.issues };
}

console.log("\n# output schemas validate real parser output");
{
  const compile = parseCompileOutput(fixtures("compile-with-errors.txt"), "", 1);
  const r1 = validates(compileResultShape, compile);
  check("compileResultShape accepts parseCompileOutput()", r1.ok, r1.error);

  const cppParsed = parseCppBuildOutput(fixtures("cpp-build-fail.txt"), "", 1);
  const cppFull = {
    ...cppParsed,
    target: "SandboxEditor",
    platform: "Mac",
    configuration: "Development",
    exitCode: 1,
    durationMs: 1234,
  };
  const r2 = validates(cppBuildResultShape, cppFull);
  check("cppBuildResultShape accepts a full CppBuildResult", r2.ok, r2.error);

  const report = parseTestReport(JSON.parse(fixtures("test-report.json")));
  const total = report.succeeded + report.failed + report.notRun;
  const runStructured = {
    mode: "run",
    passed: report.failed === 0 && total > 0,
    succeeded: report.succeeded,
    failed: report.failed,
    notRun: report.notRun,
    totalDuration: report.totalDuration,
    durationMs: 5000,
    tests: report.tests.map((t) => ({
      fullTestPath: t.fullTestPath,
      state: t.state,
      duration: t.duration,
      errors: t.errors.map((e) => e.message),
    })),
  };
  const r3 = validates(testRunStructuredShape, runStructured);
  check("testRunStructuredShape accepts run-mode output", r3.ok, r3.error);

  const listStructured = {
    mode: "list",
    durationMs: 4200,
    discoveredTests: ["Sandbox.Sanity.AlwaysPasses", "Sandbox.Sanity.AlwaysFails"],
  };
  const r4 = validates(testRunStructuredShape, listStructured);
  check("testRunStructuredShape accepts list-mode output", r4.ok, r4.error);

  const { entries, stats } = filterLog(fixtures("log-sample.txt"), {
    minSeverity: "warning",
  });
  const readStructured = {
    mode: "read",
    file: {
      path: "/tmp/Sandbox.log",
      isCurrent: true,
      source: "project",
      mtime: new Date(0).toISOString(),
      sizeBytes: 4096,
    },
    entries: entries.map((e) => ({
      timestamp: e.timestamp,
      frame: e.frame,
      category: e.category,
      severity: e.severity,
      message: e.message,
    })),
    stats,
  };
  const r5 = validates(readLogsStructuredShape, readStructured);
  check("readLogsStructuredShape accepts read-mode output", r5.ok, r5.error);

  const listLogs = {
    mode: "list",
    logs: [
      {
        index: 0,
        path: "/tmp/Sandbox.log",
        isCurrent: true,
        source: "project",
        mtime: new Date(0).toISOString(),
        sizeBytes: 4096,
      },
    ],
  };
  const r6 = validates(readLogsStructuredShape, listLogs);
  check("readLogsStructuredShape accepts list-mode output", r6.ok, r6.error);

  // Negative control: a malformed result must be rejected.
  const bad = validates(compileResultShape, { success: "yes", summary: 3 });
  check("compileResultShape rejects malformed data", bad.ok === false);
}

console.log("\n# progressFromExtra");
{
  const noToken = progressFromExtra({
    _meta: undefined,
    signal: new AbortController().signal,
    sendNotification: async () => {},
  });
  check("returns undefined when client sent no progressToken", noToken === undefined);

  const sent = [];
  const report = progressFromExtra({
    _meta: { progressToken: "tok-1" },
    signal: new AbortController().signal,
    sendNotification: async (n) => { sent.push(n); },
  });
  check("returns a function when a token is present", typeof report === "function");
  report("first");
  report("second");
  await new Promise((r) => setTimeout(r, 0));
  check("emits one notification per call", sent.length === 2, sent.length);
  check(
    "uses notifications/progress with the client token",
    sent[0]?.method === "notifications/progress" &&
      sent[0]?.params.progressToken === "tok-1",
    sent[0],
  );
  check(
    "progress increases monotonically",
    sent[0]?.params.progress === 1 && sent[1]?.params.progress === 2,
    sent.map((n) => n.params.progress),
  );
  check("carries the message", sent[0]?.params.message === "first", sent[0]?.params);
}

console.log("\n# run-control: linkAbort");
{
  let k1 = 0;
  const ac1 = new AbortController();
  ac1.abort();
  linkAbort(ac1.signal, () => k1++);
  check("already-aborted signal kills immediately", k1 === 1, k1);

  let k2 = 0;
  const ac2 = new AbortController();
  const detach2 = linkAbort(ac2.signal, () => k2++);
  check("does not kill before abort", k2 === 0, k2);
  ac2.abort();
  check("kills on abort", k2 === 1, k2);
  detach2();

  let k3 = 0;
  const ac3 = new AbortController();
  const detach3 = linkAbort(ac3.signal, () => k3++);
  detach3();
  ac3.abort();
  check("detach prevents kill", k3 === 0, k3);

  check("undefined signal returns a no-op detacher", typeof linkAbort(undefined, () => {}) === "function");
}

console.log("\n# run-control: startHeartbeat");
{
  const stopNoop = startHeartbeat(undefined, "x");
  check("undefined progress returns a no-op stop fn", typeof stopNoop === "function");
  stopNoop();

  const msgs = [];
  const stop = startHeartbeat((m) => msgs.push(m), "Building", 10_000);
  check("returns a stop fn", typeof stop === "function");
  check("does not fire synchronously", msgs.length === 0, msgs);
  stop();
}

console.log("\n# resources");
{
  clearCache(); // ensure no active project
  const reg = [];
  const fakeServer = {
    registerResource: (name, uri, config, cb) => reg.push({ name, uri, config, cb }),
  };
  registerResources(fakeServer);

  check("registers three resources", reg.length === 3, reg.map((r) => r.uri));
  const uris = reg.map((r) => r.uri).sort();
  check(
    "registers info / log / context URIs",
    uris.join(",") ===
      ["unreal://project/context", "unreal://project/info", "unreal://project/log"].join(","),
    uris,
  );

  for (const r of reg) {
    const out = await r.cb(new URL(r.uri));
    const c = out?.contents?.[0];
    check(
      `${r.uri} returns well-formed contents`,
      Array.isArray(out.contents) && c?.uri === r.uri && typeof c?.text === "string",
      out,
    );
  }

  const info = reg.find((r) => r.uri.endsWith("/info"));
  const infoOut = await info.cb(new URL(info.uri));
  check(
    "info resource reports no active project before any tool runs",
    /activeProject|No active/.test(infoOut.contents[0].text),
    infoOut.contents[0].text.slice(0, 80),
  );
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
