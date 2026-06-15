"""
Add a component to a Blueprint via SubobjectDataSubsystem — the sanctioned editor API the
Components panel itself uses. Pure Python (no ClaudeUnrealBridge plugin needed).
Driven by the `add-component` MCP tool.

Args (via builtins._claude_args):
  asset_path       : /Game/... path to the target Blueprint
  component_class   : component UClass — a UE Python name ("StaticMeshComponent",
                      "SpringArmComponent", "CameraComponent") or a class path
                      ("/Script/Engine.StaticMeshComponent", "/Game/BP/BPC_Foo.BPC_Foo_C")
  component_name   : desired variable name for the new component (optional; engine default if blank)
  parent_component : variable name of the component to attach under (optional; default = the root)
  compile          : "true"/"false" (default true) — compile the blueprint after adding
  output_file      : where to write the JSON result
"""
import json
import traceback
import builtins

import unreal


def get_args():
    return getattr(builtins, "_claude_args", {})


def resolve_class(name, default=None):
    if not name:
        return default
    if name.startswith("/"):
        obj = unreal.load_object(None, name)
        return obj if obj is not None else default
    obj = getattr(unreal, name, None)
    if obj is not None and hasattr(obj, "static_class"):
        return obj.static_class()
    try:
        found = unreal.find_class(name)
        return found if found is not None else default
    except Exception:
        return default


def _write(output_file, result):
    if output_file:
        with open(output_file, "w") as f:
            json.dump(result, f, indent=2, default=str)
    unreal.log("ADD_COMPONENT_DONE success=%s" % result.get("success"))


def main():
    args = get_args()
    output_file = args.get("output_file")
    asset_path = args.get("asset_path") or ""
    component_class_name = args.get("component_class") or ""
    component_name = args.get("component_name") or ""
    parent_component = args.get("parent_component") or ""
    do_compile = str(args.get("compile", "true")).lower() != "false"

    result = {
        "success": False,
        "asset_path": asset_path,
        "component_name": component_name,
        "component_class": component_class_name,
        "parent_component": parent_component,
        "compiled": None,
        "saved": False,
    }

    bp = unreal.EditorAssetLibrary.load_asset(asset_path)
    if bp is None or not isinstance(bp, unreal.Blueprint):
        result["error"] = "Asset is not a Blueprint (or not found): %s" % asset_path
        _write(output_file, result)
        return

    # ── Reparent mode ─────────────────────────────────────────────────────────
    # componentClass == "Reparent": attach the EXISTING component named
    # `component_name` under `parent_component` (keeps its relative transform).
    if component_class_name == "Reparent":
        try:
            sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
            lib = unreal.SubobjectDataBlueprintFunctionLibrary
            handles = sds.k2_gather_subobject_data_for_blueprint(bp)
            child_h, parent_h = None, None
            for h in handles:
                d = lib.get_data(h)
                n = str(lib.get_variable_name(d))
                if n == component_name:
                    child_h = h
                if n == parent_component:
                    parent_h = h
            if child_h is None or parent_h is None:
                result["error"] = "Reparent: component or parent not found (%s -> %s)" % (
                    component_name, parent_component)
                _write(output_file, result)
                return
            ok = sds.attach_subobject(parent_h, child_h)
            if not ok:
                result["error"] = "attach_subobject returned false"
                _write(output_file, result)
                return
            if do_compile:
                unreal.BlueprintEditorLibrary.compile_blueprint(bp)
                result["compiled"] = True
            unreal.EditorAssetLibrary.save_asset(asset_path, only_if_is_dirty=False)
            result["saved"] = True
            result["success"] = True
            _write(output_file, result)
            return
        except Exception as e:
            result["error"] = "Reparent failed: %s" % e
            _write(output_file, result)
            return

    comp_class = resolve_class(component_class_name)
    if comp_class is None:
        result["error"] = "could not resolve component_class '%s'" % component_class_name
        _write(output_file, result)
        return

    try:
        sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
        lib = unreal.SubobjectDataBlueprintFunctionLibrary
        handles = sds.k2_gather_subobject_data_for_blueprint(bp)
        if not handles:
            result["error"] = "no subobject data for blueprint"
            _write(output_file, result)
            return

        # Default parent = the first handle (the actor/root node). If a parent component name
        # was given, find the handle whose variable name matches it.
        parent_handle = handles[0]
        if parent_component:
            matched = False
            for h in handles:
                d = lib.get_data(h)
                if str(lib.get_variable_name(d)) == parent_component:
                    parent_handle = h
                    matched = True
                    break
            if not matched:
                result["error"] = "parent_component '%s' not found on blueprint" % parent_component
                _write(output_file, result)
                return

        params = unreal.AddNewSubobjectParams()
        params.set_editor_property("parent_handle", parent_handle)
        params.set_editor_property("new_class", comp_class)
        params.set_editor_property("blueprint_context", bp)

        new_handle, fail_text = sds.add_new_subobject(params)
        fail_str = str(fail_text) if fail_text is not None else ""
        if fail_str or not lib.is_handle_valid(new_handle):
            result["error"] = "add_new_subobject failed: %s" % (fail_str or "invalid handle")
            _write(output_file, result)
            return

        # Rename to the requested variable name (FText param auto-converts from a Python str).
        if component_name:
            try:
                sds.rename_subobject(new_handle, component_name)
            except Exception as e:
                result["rename_error"] = str(e)

        # Read back the final name + class for confirmation.
        try:
            nd = lib.get_data(new_handle)
            result["component_name"] = str(lib.get_variable_name(nd))
            obj = lib.get_associated_object(nd)
            if obj is not None:
                result["component_class"] = obj.get_class().get_name()
        except Exception:
            pass

        if do_compile:
            try:
                unreal.BlueprintEditorLibrary.compile_blueprint(bp)
                result["compiled"] = True
            except Exception as e:
                result["compiled"] = False
                result["compile_error"] = str(e)

        result["saved"] = bool(unreal.EditorAssetLibrary.save_loaded_asset(bp))
        result["success"] = True
    except Exception as e:
        result["error"] = "".join(traceback.format_exception_only(type(e), e)).strip()
        result["traceback"] = traceback.format_exc()

    _write(output_file, result)


main()
