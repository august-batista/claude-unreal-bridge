#!/usr/bin/env node
/**
 * End-to-end regression for the asset-authoring tools added on top of graph editing:
 *   - create-asset        (create_asset.py)        — new Blueprint + Widget Blueprint assets
 *   - edit-blueprint-graph (edit_blueprint_graph.py) — complex member variables (struct/object/array/set/map)
 *   - add-component       (add_component.py)        — components via SubobjectDataSubsystem
 *   - read-blueprint      (extract_blueprint.py)    — components surfaced via the subsystem (not T3D)
 *   - design-widget       (design_widget.py)        — UMG widget tree via UClaudeBPGraphLibrary
 *
 * Drives the real UE 5.7 editor against the in-repo sandbox project, so it SKIPS (exit 0) when UE
 * or the built sandbox editor isn't present (CI-safe), like verify-bp-graph-edit.js.
 *
 * Engine: UE_ROOT env, else "/Users/Shared/Epic Games/UE_5.7".
 * Run: node tests/verify-asset-tools.js   (or via `npm run test:assets`)
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
const pyDir = join(repoRoot, "python-scripts");

function skip(msg) {
  console.log(`SKIP verify-asset-tools: ${msg}`);
  process.exit(0);
}

if (!existsSync(editorCmd)) skip(`no UE editor at ${editorCmd} (set UE_ROOT)`);
if (!existsSync(uproject)) skip(`sandbox project missing at ${uproject}`);
if (!existsSync(sandboxDylib)) {
  skip(`sandbox editor not built — run: "${engineRoot}/Engine/Build/BatchFiles/Mac/Build.sh" SandboxEditor Mac Development -Project="${uproject}"`);
}

const work = mkdtempSync(join(tmpdir(), "asset-tools-regress-"));
const reportPath = join(work, "report.json");
const wrapperPath = join(work, "wrapper.py");
const logPath = join(work, "ed.log");

const wrapper = `import unreal, builtins, json, os, traceback
WORK = r"${work}"
SCRIPTS = r"${pyDir}"
FOLDER = "/Game/_AssetToolsRegress"
report = {}

def run(name, args, guarded=False):
    try:
        builtins._claude_args = dict(args)
        g = {"__name__": "__main__"} if guarded else {}
        with open(os.path.join(SCRIPTS, name)) as fh:
            exec(compile(fh.read(), name, "exec"), g)
    except Exception:
        report.setdefault("_errors", {})[name] = traceback.format_exc()

def load(n):
    try:
        with open(os.path.join(WORK, n)) as fh:
            return json.load(fh)
    except Exception as e:
        return {"_load_error": str(e)}

try:
    if unreal.EditorAssetLibrary.does_directory_exist(FOLDER):
        unreal.EditorAssetLibrary.delete_directory(FOLDER)
except Exception:
    pass

# create-asset: Blueprint + Widget Blueprint
run("create_asset.py", {"output_file": os.path.join(WORK, "bp.json"), "package_path": FOLDER,
                        "asset_name": "BP_Regress", "asset_kind": "blueprint", "parent_class": "Actor"})
run("create_asset.py", {"output_file": os.path.join(WORK, "wbp.json"), "package_path": FOLDER,
                        "asset_name": "WBP_Regress", "asset_kind": "widget", "parent_class": ""})
BP = FOLDER + "/BP_Regress"
WBP = FOLDER + "/WBP_Regress"

# complex member variables (struct/object/array/set/map) via edit_blueprint_graph
vops = [
 {"op": "addMemberVariable", "name": "Health", "varType": "int", "default": "100"},
 {"op": "addMemberVariable", "name": "SpawnLoc", "varType": "struct", "typePath": "Vector"},
 {"op": "addMemberVariable", "name": "Target", "varType": "object", "typePath": "Actor"},
 {"op": "addMemberVariable", "name": "Items", "varType": "object", "typePath": "Actor", "container": "array"},
 {"op": "addMemberVariable", "name": "Flags", "varType": "name", "container": "set"},
 {"op": "addMemberVariable", "name": "Scores", "varType": "name", "container": "map", "valueType": "int"},
]
run("edit_blueprint_graph.py", {"output_file": os.path.join(WORK, "vars.json"), "asset_path": BP,
                                "graph_name": "", "operations": json.dumps(vops), "compile": "true", "auto_layout": "false"})

# add-component: Mesh at root, Boom nested under Mesh
run("add_component.py", {"output_file": os.path.join(WORK, "comp1.json"), "asset_path": BP,
                         "component_class": "StaticMeshComponent", "component_name": "Mesh", "parent_component": "", "compile": "true"})
run("add_component.py", {"output_file": os.path.join(WORK, "comp2.json"), "asset_path": BP,
                         "component_class": "SpringArmComponent", "component_name": "Boom", "parent_component": "Mesh", "compile": "true"})

# design-widget: a small UMG layout
wops = [
 {"op": "addWidget", "widgetClass": "CanvasPanel", "name": "RootCanvas", "parent": ""},
 {"op": "addWidget", "widgetClass": "Border", "name": "Panel", "parent": "RootCanvas"},
 {"op": "setCanvasSlot", "widget": "Panel", "x": 40, "y": 40, "width": 400, "height": 300},
 {"op": "addWidget", "widgetClass": "VerticalBox", "name": "VBox", "parent": "Panel"},
 {"op": "addWidget", "widgetClass": "TextBlock", "name": "Title", "parent": "VBox"},
 {"op": "addWidget", "widgetClass": "Button", "name": "CloseBtn", "parent": "VBox"},
]
run("design_widget.py", {"output_file": os.path.join(WORK, "widget.json"), "asset_path": WBP,
                         "operations": json.dumps(wops), "compile": "true"})

# read-blueprint (extractor module): components should surface via the subsystem
import sys as _sys
_sys.path.insert(0, SCRIPTS)
import extract_blueprint as _eb
read = _eb.extract_blueprint(BP)

report["create_bp"] = load("bp.json")
report["create_wbp"] = load("wbp.json")
report["vars"] = load("vars.json")
report["comp1"] = load("comp1.json")
report["comp2"] = load("comp2.json")
report["widget"] = load("widget.json")
report["read_components"] = read.get("components")
report["read_variable_names"] = [v.get("name") for v in read.get("variables", [])]

json.dump(report, open(r"${reportPath}", "w"), indent=2, default=str)
try:
    unreal.EditorAssetLibrary.delete_directory(FOLDER)
except Exception:
    pass
`;
writeFileSync(wrapperPath, wrapper);

console.log("# Booting sandbox editor to author + verify assets/components/widgets (this takes ~2-3 min)…");
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
check("no driver errors", !d._errors, d._errors);

// create-asset
check("created Blueprint asset", d.create_bp && d.create_bp.success === true, d.create_bp);
check("created Widget Blueprint asset", d.create_wbp && d.create_wbp.success === true, d.create_wbp);

// complex variables
check("variable batch succeeded", d.vars && d.vars.success === true, d.vars && d.vars.error);
const badVarOps = (d.vars?.operations || []).filter((o) => !o.ok);
check("every addMemberVariable op ok (incl. struct/object/array/set/map)", badVarOps.length === 0, badVarOps);
for (const v of ["Health", "SpawnLoc", "Target", "Items", "Scores"]) {
  check(`read-back shows variable ${v}`, (d.read_variable_names || []).includes(v), d.read_variable_names);
}

// components (write + read fix)
check("added component Mesh", d.comp1 && d.comp1.success === true && d.comp1.component_name === "Mesh", d.comp1);
check("added nested component Boom", d.comp2 && d.comp2.success === true && d.comp2.component_name === "Boom", d.comp2);
const flat = [];
(function walk(list, parent) {
  for (const c of list || []) { flat.push({ name: c.name, type: c.type, parent }); walk(c.children, c.name); }
})(d.read_components, "");
check("reader surfaces Mesh (StaticMeshComponent)", flat.some((c) => c.name === "Mesh" && c.type === "StaticMeshComponent"), flat);
check("reader surfaces Boom nested under Mesh", flat.some((c) => c.name === "Boom" && c.parent === "Mesh"), flat);

// design-widget
check("widget design succeeded", d.widget && d.widget.success === true, d.widget && d.widget.error);
const badWOps = (d.widget?.operations || []).filter((o) => !o.ok);
check("every widget op ok", badWOps.length === 0, badWOps);
const wlist = d.widget?.widgets || [];
const hasW = (name, cls, parent) => wlist.some((s) => s === `${name}|${cls}|${parent}`);
check("widget tree: RootCanvas is the CanvasPanel root", hasW("RootCanvas", "CanvasPanel", ""), wlist);
check("widget tree: Panel(Border) under RootCanvas", hasW("Panel", "Border", "RootCanvas"), wlist);
check("widget tree: VBox under Panel", hasW("VBox", "VerticalBox", "Panel"), wlist);
check("widget tree: Title(TextBlock) under VBox", hasW("Title", "TextBlock", "VBox"), wlist);
check("widget tree: CloseBtn(Button) under VBox", hasW("CloseBtn", "Button", "VBox"), wlist);
check("widget compiled", d.widget && d.widget.compiled === true, d.widget && d.widget.compile_error);

try { rmSync(work, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) { console.log("Failures:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
