"""
Create a new Blueprint or Widget Blueprint asset (empty shell) via AssetTools + a factory.

Pure Python — no ClaudeUnrealBridge plugin needed. Uses the same
FKismetEditorUtilities::CreateBlueprint path Epic's own editor tools use (AssetTools.create_asset
with a UBlueprintFactory / UWidgetBlueprintFactory). Driven by the `create-asset` MCP tool.

Args (via builtins._claude_args):
  package_path : content folder for the new asset (e.g. /Game/Blueprints); default /Game
  asset_name   : new asset name, no extension (e.g. BP_Inventory)
  asset_kind   : "blueprint" (Actor/Object BP) or "widget" (Widget BP / UMG); default blueprint
  parent_class : parent UClass — a UE Python name ("Actor", "Pawn", "UserWidget") or a class path
                 ("/Script/Engine.Actor", "/Game/BP/BP_Base.BP_Base_C"). Defaults per kind.
  output_file  : where to write the JSON result
"""
import json
import traceback
import builtins

import unreal


def get_args():
    return getattr(builtins, "_claude_args", {})


def resolve_class(name, default=None):
    """Resolve a UClass from a friendly Python name ("Actor") or a path ("/Script/Engine.Actor",
    "/Game/BP/BP_Base.BP_Base_C"). Returns `default` if unresolved."""
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
    unreal.log("CREATE_ASSET_DONE success=%s" % result.get("success"))


def main():
    args = get_args()
    output_file = args.get("output_file")
    package_path = (args.get("package_path") or "/Game").rstrip("/")
    asset_name = args.get("asset_name") or ""
    asset_kind = (args.get("asset_kind") or "blueprint").lower()
    parent_class_name = args.get("parent_class") or ""

    result = {
        "success": False,
        "asset_kind": asset_kind,
        "asset_path": "",
        "parent_class": "",
        "saved": False,
    }

    if not asset_name:
        result["error"] = "asset_name is required"
        _write(output_file, result)
        return

    full_path = "%s/%s" % (package_path, asset_name)
    if unreal.EditorAssetLibrary.does_asset_exist(full_path):
        result["asset_path"] = full_path
        result["error"] = "asset already exists: %s" % full_path
        _write(output_file, result)
        return

    try:
        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        if asset_kind == "widget":
            factory = unreal.WidgetBlueprintFactory()
            parent = resolve_class(parent_class_name, unreal.UserWidget)
            # Widget factories don't always expose parent_class as settable; best-effort.
            try:
                factory.set_editor_property("parent_class", parent)
            except Exception:
                pass
            asset_class = unreal.WidgetBlueprint
        else:
            factory = unreal.BlueprintFactory()
            parent = resolve_class(parent_class_name, unreal.Actor)
            factory.set_editor_property("parent_class", parent)
            asset_class = unreal.Blueprint

        new_asset = asset_tools.create_asset(asset_name, package_path, asset_class, factory)
        if new_asset is None:
            result["error"] = "create_asset returned None (invalid package_path or parent class?)"
            _write(output_file, result)
            return

        # /Game/Folder/Name.Name -> /Game/Folder/Name
        result["asset_path"] = new_asset.get_path_name().split(".")[0]
        try:
            result["parent_class"] = parent.get_name() if parent is not None else ""
        except Exception:
            pass
        result["saved"] = bool(unreal.EditorAssetLibrary.save_loaded_asset(new_asset))
        result["success"] = True
    except Exception as e:
        result["error"] = "".join(traceback.format_exception_only(type(e), e)).strip()
        result["traceback"] = traceback.format_exc()

    _write(output_file, result)


main()
