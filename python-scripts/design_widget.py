"""
Design a Widget Blueprint's UMG layout: add widgets to the tree and position them in canvas
slots, then compile + save. Driven by the `design-widget` MCP tool.

Calls UClaudeBPGraphLibrary's UMG methods (shipped by the ClaudeUnrealBridge editor plugin; the
sandbox ClaudeBPGraph plugin exposes the same class), which wrap UWidgetTree::ConstructWidget +
UPanelWidget::AddChild — the same path UE 5.8's UMGToolSet uses, all present in 5.7. WidgetTree
population needs this C++: UWidgetTree isn't exposed to Python (the asset itself is created in pure
Python by create_asset.py / the create-asset tool).

Args (via builtins._claude_args):
  asset_path  : /Game/... path to the Widget Blueprint (create it first with create-asset)
  operations  : JSON array of ops (see below)
  compile     : "true"/"false" (default true)
  output_file : where to write the JSON result

Operation kinds:
  {"op":"addWidget","widgetClass":"CanvasPanel","name":"RootCanvas","parent":"","childIndex":-1}
  {"op":"addWidget","widgetClass":"Button","name":"PlayBtn","parent":"RootCanvas"}
  {"op":"setCanvasSlot","widget":"PlayBtn","x":100,"y":50,"width":200,"height":60,"autoSize":false}

The first addWidget with an empty parent becomes the tree root; later widgets attach under a named
panel. setCanvasSlot positions a widget that lives directly under a CanvasPanel.
"""
import json
import traceback
import builtins

import unreal


def get_args():
    return getattr(builtins, "_claude_args", {})


def resolve_class(name):
    if not name:
        return None
    if name.startswith("/"):
        return unreal.load_object(None, name)
    obj = getattr(unreal, name, None)
    if obj is not None and hasattr(obj, "static_class"):
        return obj.static_class()
    try:
        return unreal.find_class(name)
    except Exception:
        return None


def _write(output_file, result):
    if output_file:
        with open(output_file, "w") as f:
            json.dump(result, f, indent=2, default=str)
    unreal.log("DESIGN_WIDGET_DONE success=%s" % result.get("success"))


def main():
    args = get_args()
    output_file = args.get("output_file")
    asset_path = args.get("asset_path", "")
    do_compile = str(args.get("compile", "true")).lower() != "false"
    try:
        ops = json.loads(args.get("operations", "[]"))
    except Exception:
        ops = []

    result = {
        "success": False,
        "asset_path": asset_path,
        "operations": [],
        "widgets": [],
        "compiled": None,
        "saved": False,
    }

    GraphLib = getattr(unreal, "ClaudeBPGraphLibrary", None)
    if GraphLib is None:
        result["error"] = (
            "UClaudeBPGraphLibrary is not available. Enable the ClaudeUnrealBridge plugin in this "
            "project and build its editor target once, then retry."
        )
        _write(output_file, result)
        return

    wbp = unreal.EditorAssetLibrary.load_asset(asset_path)
    if wbp is None or not isinstance(wbp, unreal.WidgetBlueprint):
        result["error"] = "Asset is not a Widget Blueprint (or not found): %s" % asset_path
        _write(output_file, result)
        return

    for i, op in enumerate(ops):
        rec = {"index": i, "op": op.get("op", "?")}
        try:
            kind = op.get("op")
            if kind == "addWidget":
                wclass = resolve_class(op.get("widgetClass", ""))
                if wclass is None:
                    raise ValueError("could not resolve widgetClass '%s'" % op.get("widgetClass"))
                name = GraphLib.add_widget_to_tree(
                    wbp, wclass, op["name"], op.get("parent", ""), int(op.get("childIndex", -1)))
                rec["ok"] = bool(name)
                rec["name"] = name
                if not name:
                    rec["error"] = "add failed (name taken, parent missing/not a panel, or panel full)"
            elif kind == "setCanvasSlot":
                rec["ok"] = bool(GraphLib.set_canvas_slot_layout(
                    wbp, op["widget"],
                    float(op.get("x", 0)), float(op.get("y", 0)),
                    float(op.get("width", 100)), float(op.get("height", 30)),
                    float(op.get("alignX", 0)), float(op.get("alignY", 0)),
                    bool(op.get("autoSize", False))))
                if not rec["ok"]:
                    rec["error"] = "widget not found or not in a CanvasPanel slot"
            else:
                rec["ok"] = False
                rec["error"] = "unknown op '%s'" % kind
        except Exception as e:
            rec["ok"] = False
            rec["error"] = "".join(traceback.format_exception_only(type(e), e)).strip()
        result["operations"].append(rec)

    if do_compile:
        try:
            unreal.BlueprintEditorLibrary.compile_blueprint(wbp)
            result["compiled"] = True
        except Exception as e:
            result["compiled"] = False
            result["compile_error"] = str(e)

    try:
        result["saved"] = bool(unreal.EditorAssetLibrary.save_loaded_asset(wbp))
    except Exception as e:
        result["saved"] = False
        result["save_error"] = str(e)

    try:
        result["widgets"] = [str(s) for s in GraphLib.list_widgets(wbp)]
    except Exception as e:
        result["widgets_error"] = str(e)

    ops_ok = all(o.get("ok") for o in result["operations"]) if result["operations"] else True
    result["success"] = bool(ops_ok and (result["compiled"] is not False))
    _write(output_file, result)


main()
