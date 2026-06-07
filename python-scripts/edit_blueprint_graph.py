"""
Apply a batch of Blueprint graph edits in a single editor session, then compile + save.

Driven by the `edit-blueprint-graph` MCP tool. Calls UClaudeBPGraphLibrary (shipped by
the ClaudeUnrealBridge editor plugin; the sandbox spike plugin exposes the same class),
which wraps the standard UE editor graph APIs (FGraphNodeCreator, schema TryCreateConnection,
UEdGraph::RemoveNode, FKismetEditorUtilities::CompileBlueprint).

Args (via builtins._claude_args):
  asset_path   : /Game/... path to the Blueprint
  graph_name   : graph to edit; "" = the event graph (default)
  operations   : JSON array of ops (see below)
  compile      : "true"/"false" (default true) — compile after applying ops
  output_file  : where to write the JSON result

Operation kinds (each a JSON object with "op"):
  {"op":"addFunctionNode","id":"h1","functionOwner":"SystemLibrary","functionName":"PrintString","x":0,"y":0}
  {"op":"addCustomEvent","id":"evt","eventName":"MyEvent","x":-300,"y":0}
  {"op":"connect","from":"evt","fromPin":"then","to":"h1","toPin":"execute"}
  {"op":"setPinDefault","node":"h1","pin":"InString","value":"Hello"}
  {"op":"deleteNode","node":"<localId-or-existing-GUID>"}

Node references ("from"/"to"/"node") resolve against local ids assigned by earlier add ops;
anything not a known local id is treated as an existing node GUID (from read-blueprint).
"""
import json
import traceback
import builtins

import unreal


def get_args():
    return getattr(builtins, "_claude_args", {})


def main():
    args = get_args()
    asset_path = args.get("asset_path", "")
    graph_name = args.get("graph_name", "")
    output_file = args.get("output_file")
    do_compile = str(args.get("compile", "true")).lower() != "false"
    auto_layout = str(args.get("auto_layout", "false")).lower() == "true"
    try:
        ops = json.loads(args.get("operations", "[]"))
    except Exception as e:
        ops = []

    result = {
        "success": False,
        "asset_path": asset_path,
        "graph": graph_name,
        "operations": [],
        "handles": {},
        "compiled": None,
        "saved": None,
        "nodes": [],
    }

    GraphLib = getattr(unreal, "ClaudeBPGraphLibrary", None)
    if GraphLib is None:
        result["error"] = (
            "UClaudeBPGraphLibrary is not available. Enable the ClaudeUnrealBridge "
            "plugin in this project and build its editor target (the ClaudeUnrealBridgeEditor "
            "module) once, then retry."
        )
        _write(output_file, result)
        return

    bp = unreal.EditorAssetLibrary.load_asset(asset_path)
    if bp is None or not isinstance(bp, unreal.Blueprint):
        result["error"] = "Asset is not a Blueprint (or not found): %s" % asset_path
        _write(output_file, result)
        return

    handles = {}

    def resolve_node(ref):
        return handles.get(ref, ref)

    def resolve_class(name):
        if not name:
            return None
        # Full object path, e.g. "/Script/Engine.KismetSystemLibrary" or a BP class path.
        if name.startswith("/"):
            obj = unreal.load_object(None, name)
            return obj
        # Python-exposed class name, e.g. "SystemLibrary" (== UKismetSystemLibrary),
        # "GameplayStatics", "MathLibrary", or a user UCLASS.
        obj = getattr(unreal, name, None)
        if obj is not None and hasattr(obj, "static_class"):
            return obj.static_class()
        if hasattr(unreal, "find_class"):
            try:
                return unreal.find_class(name)
            except Exception:
                return None
        return None

    for i, op in enumerate(ops):
        rec = {"index": i, "op": op.get("op", "?")}
        try:
            kind = op.get("op")
            if kind == "addFunctionNode":
                owner = resolve_class(op.get("functionOwner", ""))
                if owner is None:
                    raise ValueError("could not resolve functionOwner '%s'" % op.get("functionOwner"))
                guid = GraphLib.add_function_call_node(
                    bp, graph_name, owner, op["functionName"],
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addCustomEvent":
                guid = GraphLib.add_custom_event_node(
                    bp, graph_name, op["eventName"],
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "connect":
                rec["ok"] = bool(GraphLib.connect_pins(
                    bp, graph_name, resolve_node(op["from"]), op["fromPin"],
                    resolve_node(op["to"]), op["toPin"]))
            elif kind == "setPinDefault":
                rec["ok"] = bool(GraphLib.set_pin_default(
                    bp, graph_name, resolve_node(op["node"]), op["pin"], op["value"]))
            elif kind == "deleteNode":
                rec["ok"] = bool(GraphLib.delete_node(
                    bp, graph_name, resolve_node(op["node"])))
            elif kind == "addMemberVariable":
                rec["ok"] = bool(GraphLib.add_member_variable(
                    bp, op["name"], op.get("varType", "int"), str(op.get("default", ""))))
            elif kind == "addVariableGet":
                guid = GraphLib.add_variable_get_node(
                    bp, graph_name, op["variable"],
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addVariableSet":
                guid = GraphLib.add_variable_set_node(
                    bp, graph_name, op["variable"],
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addBranch":
                guid = GraphLib.add_branch_node(
                    bp, graph_name, int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addSequence":
                guid = GraphLib.add_sequence_node(
                    bp, graph_name, int(op.get("numOutputs", 2)),
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addMacro":
                guid = GraphLib.add_macro_instance_node(
                    bp, graph_name, op["macro"],
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addCast":
                owner = resolve_class(op.get("targetClass", ""))
                if owner is None:
                    raise ValueError("could not resolve targetClass '%s'" % op.get("targetClass"))
                guid = GraphLib.add_cast_node(
                    bp, graph_name, owner, bool(op.get("pure", False)),
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "addSelfFunctionNode":
                guid = GraphLib.add_self_function_call_node(
                    bp, graph_name, op["functionName"],
                    int(op.get("x", 0)), int(op.get("y", 0)))
                rec["guid"] = guid
                rec["ok"] = bool(guid)
                if op.get("id") and guid:
                    handles[op["id"]] = guid
            elif kind == "breakPinLink":
                rec["ok"] = bool(GraphLib.break_pin_link(
                    bp, graph_name, resolve_node(op["from"]), op["fromPin"],
                    resolve_node(op["to"]), op["toPin"]))
            elif kind == "retargetNode":
                node = resolve_node(op["node"])
                if "functionName" in op:
                    owner = resolve_class(op.get("functionOwner", ""))
                    if owner is None:
                        raise ValueError("retargetNode: could not resolve functionOwner '%s'" % op.get("functionOwner"))
                    rec["ok"] = bool(GraphLib.retarget_function_node(bp, graph_name, node, owner, op["functionName"]))
                elif "targetClass" in op:
                    owner = resolve_class(op["targetClass"])
                    if owner is None:
                        raise ValueError("retargetNode: could not resolve targetClass '%s'" % op.get("targetClass"))
                    rec["ok"] = bool(GraphLib.retarget_cast_node(bp, graph_name, node, owner))
                elif "variable" in op:
                    rec["ok"] = bool(GraphLib.retarget_variable_node(bp, graph_name, node, op["variable"]))
                elif "eventName" in op:
                    rec["ok"] = bool(GraphLib.rename_custom_event_node(bp, graph_name, node, op["eventName"]))
                else:
                    rec["ok"] = False
                    rec["error"] = "retargetNode needs one of: functionName(+functionOwner), targetClass, variable, eventName"
            elif kind == "moveNode":
                rec["ok"] = bool(GraphLib.set_node_position(
                    bp, graph_name, resolve_node(op["node"]),
                    int(op.get("x", 0)), int(op.get("y", 0))))
            else:
                rec["ok"] = False
                rec["error"] = "unknown op '%s'" % kind
        except Exception as e:
            rec["ok"] = False
            rec["error"] = "".join(traceback.format_exception_only(type(e), e)).strip()
        result["operations"].append(rec)

    if auto_layout:
        try:
            result["auto_layout"] = bool(GraphLib.auto_layout_graph(bp, graph_name))
        except Exception as e:
            result["auto_layout"] = False
            result["auto_layout_error"] = str(e)

    if do_compile:
        try:
            result["compiled"] = bool(GraphLib.compile_blueprint_asset(bp))
        except Exception as e:
            result["compiled"] = False
            result["compile_error"] = str(e)

    try:
        result["saved"] = bool(unreal.EditorAssetLibrary.save_loaded_asset(bp))
    except Exception as e:
        result["saved"] = False
        result["save_error"] = str(e)

    try:
        result["nodes"] = [str(s) for s in GraphLib.list_node_guids(bp, graph_name)]
    except Exception as e:
        result["nodes_error"] = str(e)

    result["handles"] = handles
    ops_ok = all(o.get("ok") for o in result["operations"]) if result["operations"] else True
    compile_ok = (result["compiled"] is not False) if do_compile else True
    result["success"] = bool(ops_ok and compile_ok)

    _write(output_file, result)


def _write(output_file, result):
    if output_file:
        with open(output_file, "w") as f:
            json.dump(result, f, indent=2, default=str)
    unreal.log("EDIT_BP_GRAPH_DONE success=%s" % result.get("success"))


main()
