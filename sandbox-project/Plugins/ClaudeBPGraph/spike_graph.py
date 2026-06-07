"""
End-to-end proof on UE 5.7: author Blueprint graph logic from scratch via our
C++ library (UClaudeBPGraphLibrary), compile, verify the wire persisted, save.
Builds: CustomEvent "SpikeEvent" --exec--> PrintString("Hello from Claude graph spike").
Writes a JSON report. Every step isolated so one failure never aborts the rest.
"""
import unreal, json, traceback

REPORT = "/tmp/claude-bp-graph-spike/report.json"
ASSET = "/Game/SpikeGraphBP"
R = {"steps": [], "summary": {}}


def step(name, fn):
    e = {"name": name}
    try:
        e["value"] = fn()
        e["status"] = "ok"
    except Exception as ex:
        e["status"] = "error"
        e["error"] = "".join(traceback.format_exception_only(type(ex), ex)).strip()
        e["trace"] = traceback.format_exc()[-1200:]
    R["steps"].append(e)
    return e.get("value")


lib = unreal.ClaudeBPGraphLibrary

# Fresh asset every run.
def make_bp():
    if unreal.EditorAssetLibrary.does_asset_exist(ASSET):
        unreal.EditorAssetLibrary.delete_asset(ASSET)
    factory = unreal.BlueprintFactory()
    factory.set_editor_property("parent_class", unreal.Actor)
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    return tools.create_asset("SpikeGraphBP", "/Game", unreal.Blueprint, factory)

bp = None
def _make_and_record():
    global bp
    bp = make_bp()
    return bp.get_path_name() if bp else None
step("create_blueprint", _make_and_record)

evt = step("add_custom_event",
           lambda: lib.add_custom_event_node(bp, "", "SpikeEvent", -360, 0))
call = step("add_printstring_call",
            lambda: lib.add_function_call_node(bp, "", unreal.SystemLibrary.static_class(), "PrintString", 220, 0))

step("connect_exec_then_to_execute",
     lambda: lib.connect_pins(bp, "", evt, "then", call, "execute"))
step("set_instring_default",
     lambda: lib.set_pin_default(bp, "", call, "InString", "Hello from Claude graph spike"))

step("compile", lambda: lib.compile_blueprint_asset(bp))

# Verify the wire survived compilation, then dump the graph.
connected_after = step("verify_connected_after_compile",
                       lambda: lib.are_nodes_connected(bp, "", evt, "then", call, "execute"))
nodes = step("list_nodes", lambda: [str(s) for s in lib.list_node_guids(bp, "")])

step("save", lambda: unreal.EditorAssetLibrary.save_loaded_asset(bp))

# Bonus: delete the call node, recompile, confirm it's gone — exercises delete too.
step("delete_call_node", lambda: lib.delete_node(bp, "", call))
step("recompile_after_delete", lambda: lib.compile_blueprint_asset(bp))
nodes_after_delete = step("list_nodes_after_delete",
                          lambda: [str(s) for s in lib.list_node_guids(bp, "")])

ok = (bool(evt) and bool(call)
      and connected_after is True
      and any(call in n for n in (nodes or []))
      and not any(call in n for n in (nodes_after_delete or [])))
R["summary"] = {
    "event_guid": evt, "call_guid": call,
    "wire_persisted_through_compile": connected_after,
    "node_count_after_author": len(nodes or []),
    "node_count_after_delete": len(nodes_after_delete or []),
    "ok_steps": sum(1 for s in R["steps"] if s["status"] == "ok"),
    "error_steps": sum(1 for s in R["steps"] if s["status"] == "error"),
    "PASS": bool(ok),
}

with open(REPORT, "w") as f:
    json.dump(R, f, indent=2, default=str)
unreal.log("SPIKE_GRAPH_DONE PASS=%s -> %s" % (R["summary"]["PASS"], REPORT))
