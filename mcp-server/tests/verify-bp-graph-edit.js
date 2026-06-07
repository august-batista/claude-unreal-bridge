#!/usr/bin/env node
/**
 * End-to-end regression for Blueprint graph editing: authors a graph with the full set of
 * node types via the production driver (python-scripts/edit_blueprint_graph.py +
 * UClaudeBPGraphLibrary), compiles, auto-lays-out, saves, then reads the graph back and
 * asserts the expected nodes + connections + compile + layout.
 *
 * Drives the real UE 5.7 editor against the in-repo sandbox project, so it SKIPS (exit 0)
 * when UE or the built sandbox editor isn't present (CI-safe), like verify-bearships-*.js.
 *
 * Engine: UE_ROOT env, else "/Users/Shared/Epic Games/UE_5.7".
 * Run: node tests/verify-bp-graph-edit.js   (or via `npm run test:graph`)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const engineRoot = process.env.UE_ROOT || "/Users/Shared/Epic Games/UE_5.7";
const editorCmd = join(engineRoot, "Engine/Binaries/Mac/UnrealEditor-Cmd");
const uproject = join(repoRoot, "sandbox-project", "Sandbox.uproject");
const sandboxDylib = join(repoRoot, "sandbox-project", "Binaries", "Mac", "UnrealEditor-Sandbox.dylib");
const editScript = join(repoRoot, "python-scripts", "edit_blueprint_graph.py");
const pyDir = join(repoRoot, "python-scripts");

function skip(msg) {
  console.log(`SKIP verify-bp-graph-edit: ${msg}`);
  process.exit(0);
}

if (!existsSync(editorCmd)) skip(`no UE editor at ${editorCmd} (set UE_ROOT)`);
if (!existsSync(uproject)) skip(`sandbox project missing at ${uproject}`);
if (!existsSync(sandboxDylib)) {
  skip(`sandbox editor not built — run: "${engineRoot}/Engine/Build/BatchFiles/Mac/Build.sh" SandboxEditor Mac Development -Project="${uproject}"`);
}

const work = mkdtempSync(join(tmpdir(), "bp-graph-regress-"));
const reportPath = join(work, "report.json");
const wrapperPath = join(work, "wrapper.py");
const logPath = join(work, "ed.log");

const wrapper = `import unreal, builtins, json
AP = "/Game/RegressionGraphBP"
if unreal.EditorAssetLibrary.does_asset_exist(AP):
    unreal.EditorAssetLibrary.delete_asset(AP)
f = unreal.BlueprintFactory(); f.set_editor_property("parent_class", unreal.Actor)
bp = unreal.AssetToolsHelpers.get_asset_tools().create_asset("RegressionGraphBP", "/Game", unreal.Blueprint, f)
GL = unreal.ClaudeBPGraphLibrary
begin = None
for e in GL.list_node_guids(bp, ""):
    p = str(e).split("|")
    if len(p) >= 3 and "BeginPlay" in p[2]:
        begin = p[0]; break
ops = [
 {"op":"addMemberVariable","name":"Counter","varType":"int","default":"0"},
 {"op":"addSequence","id":"seq","numOutputs":2},
 {"op":"addBranch","id":"br"},
 {"op":"addVariableGet","id":"getC","variable":"Counter"},
 {"op":"addFunctionNode","id":"cmp","functionOwner":"MathLibrary","functionName":"Greater_IntInt"},
 {"op":"addFunctionNode","id":"pPos","functionOwner":"SystemLibrary","functionName":"PrintString"},
 {"op":"addFunctionNode","id":"pZero","functionOwner":"SystemLibrary","functionName":"PrintString"},
 {"op":"addFunctionNode","id":"pLoop","functionOwner":"SystemLibrary","functionName":"PrintString"},
 {"op":"addMacro","id":"fl","macro":"ForLoop"},
 {"op":"addCast","id":"castA","targetClass":"Actor","pure":False},
 {"op":"addSelfFunctionNode","id":"selfFn","functionName":"K2_DestroyActor"},
 {"op":"setPinDefault","node":"cmp","pin":"B","value":"0"},
 {"op":"setPinDefault","node":"pPos","pin":"InString","value":"positive"},
 {"op":"setPinDefault","node":"pZero","pin":"InString","value":"zero"},
 {"op":"setPinDefault","node":"pLoop","pin":"InString","value":"loop"},
 {"op":"connect","from":"seq","fromPin":"then_0","to":"br","toPin":"execute"},
 {"op":"connect","from":"seq","fromPin":"then_1","to":"pLoop","toPin":"execute"},
 {"op":"connect","from":"getC","fromPin":"Counter","to":"cmp","toPin":"A"},
 {"op":"connect","from":"cmp","fromPin":"ReturnValue","to":"br","toPin":"Condition"},
 {"op":"connect","from":"br","fromPin":"then","to":"pPos","toPin":"execute"},
 {"op":"connect","from":"br","fromPin":"else","to":"pZero","toPin":"execute"},
 {"op":"retargetNode","node":"castA","targetClass":"PawnMovementComponent"},
 {"op":"breakPinLink","from":"seq","fromPin":"then_1","to":"pLoop","toPin":"execute"},
]
if begin:
    ops.insert(15, {"op":"connect","from":begin,"fromPin":"then","to":"seq","toPin":"execute"})
builtins._claude_args = {
    "output_file": r"${reportPath}",
    "asset_path": AP, "graph_name": "",
    "operations": json.dumps(ops), "compile": "true", "auto_layout": "true",
}
exec(open(r"${editScript}").read())
import sys as _sys, json as _j
# Read side (T3D, no bridge): import the extractor and collect its event-graph edges.
_sys.path.insert(0, r"${pyDir}")
import extract_blueprint as _eb
_read = _eb.extract_blueprint(AP)
_read_conns = []
for _g in _read.get("eventGraphs", []):
    for _c in _g.get("connections", []):
        _read_conns.append("%s|%s|%s|%s|%s" % (_c["from"], _c["fromPin"], _c["to"], _c["toPin"], _c["kind"]))
_r = _j.load(open(r"${reportPath}"))
_r["read_connections"] = _read_conns
_h = _r.get("handles", {})
try:
    _r["checks"] = {"seq_then1_to_pLoop": bool(GL.are_nodes_connected(bp, "", _h.get("seq",""), "then_1", _h.get("pLoop",""), "execute"))}
except Exception as _e:
    _r["checks"] = {"error": str(_e)}
_j.dump(_r, open(r"${reportPath}", "w"), indent=2, default=str)
unreal.EditorAssetLibrary.delete_asset(AP)
`;
writeFileSync(wrapperPath, wrapper);

console.log("# Booting sandbox editor to author + verify a graph (this takes ~1-2 min)…");
const res = spawnSync(
  editorCmd,
  [uproject, "-run=pythonscript", `-script=${wrapperPath}`,
   "-unattended", "-nopause", "-nullrhi", "-nosound", "-nosplash", `-AbsLog=${logPath}`],
  { timeout: 360000, stdio: "ignore" },
);

let pass = 0, fail = 0;
const fails = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; fails.push(label); console.log(`  ✗ ${label}`); if (detail !== undefined) console.log(`    ${JSON.stringify(detail)}`); }
}

if (!existsSync(reportPath)) {
  console.log(`  ✗ no report produced (editor exit ${res.status}). Log tail:`);
  try { console.log(readFileSync(logPath, "utf-8").split("\n").slice(-25).join("\n")); } catch {}
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

const d = JSON.parse(readFileSync(reportPath, "utf-8"));
check("batch succeeded", d.success === true, d.summary ?? d);
check("compiled", d.compiled === true, { compiled: d.compiled, compile_error: d.compile_error });
check("auto_layout ran", d.auto_layout === true);
const badOps = (d.operations || []).filter((o) => !o.ok);
check("every op ok", badOps.length === 0, badOps);

const classes = (d.nodes || []).map((n) => String(n).split("|")[1]);
for (const cls of [
  "K2Node_ExecutionSequence",
  "K2Node_MacroInstance",
  "K2Node_IfThenElse",
  "K2Node_DynamicCast",
  "K2Node_VariableGet",
]) {
  check(`graph contains ${cls}`, classes.includes(cls), classes);
}
const printCount = classes.filter((c) => c === "K2Node_CallFunction").length;
check("graph has >= 4 CallFunction nodes (3 prints + compare)", printCount >= 4, printCount);

const titles = (d.nodes || []).map((n) => String(n).split("|")[2] || "");
check(
  "retargetNode changed the cast's target (title shows Movement)",
  titles.some((t) => t.includes("Movement")),
  titles,
);
check(
  "breakPinLink disconnected seq.then_1 -> pLoop",
  d.checks && d.checks.seq_then1_to_pLoop === false,
  d.checks,
);

// Round-trip: the write side (bridge ListGraphConnections) and the read side
// (extract_blueprint T3D) must report the same edges, keyed by NodeGuid + pin name.
const h = d.handles || {};
const live = d.connections || [];
const read = d.read_connections || [];
const hasEdge = (list, from, fromPin, to, toPin) =>
  list.some((s) => {
    const p = String(s).split("|");
    return p[0] === from && p[1] === fromPin && p[2] === to && p[3] === toPin;
  });
check("bridge returned a live edge list", live.length > 0, live.length);
check("read (T3D) returned an edge list", read.length > 0, read.length);
check("live edge getC.Counter -> cmp.A", hasEdge(live, h.getC, "Counter", h.cmp, "A"), live);
check("live edge cmp.ReturnValue -> br.Condition", hasEdge(live, h.cmp, "ReturnValue", h.br, "Condition"), live);
check("read (T3D) agrees on getC.Counter -> cmp.A", hasEdge(read, h.getC, "Counter", h.cmp, "A"), read);
check("read (T3D) agrees on cmp.ReturnValue -> br.Condition", hasEdge(read, h.cmp, "ReturnValue", h.br, "Condition"), read);

try { rmSync(work, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) { console.log("Failures:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
