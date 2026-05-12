"""
List all blueprints in a UE project.
Runs inside the UE editor via -run=pythonscript.

Reads arguments from builtins._claude_args:
  - output_file: Where to write the JSON output
  - filter: Optional filter string (class name, path prefix, or parent class)
  - type: Optional type filter (actor, widget, animation, interface)
"""

import json
import unreal


def get_args():
    import builtins
    return getattr(builtins, '_claude_args', {})


def list_blueprints(filter_str='', type_filter=''):
    """List all blueprints in the project."""
    asset_registry = unreal.AssetRegistryHelpers.get_asset_registry()

    # Define blueprint class names to search for
    blueprint_classes = {
        'Blueprint': 'Blueprint',
        'WidgetBlueprint': 'WidgetBlueprint',
        'AnimBlueprint': 'AnimBlueprint',
    }

    # Map type filter to class names
    type_class_map = {
        'widget': ['WidgetBlueprint'],
        'animation': ['AnimBlueprint'],
        'actor': ['Blueprint'],
        'interface': ['Blueprint'],  # Interfaces are also Blueprint class
    }

    classes_to_search = list(blueprint_classes.keys())
    if type_filter and type_filter in type_class_map:
        classes_to_search = type_class_map[type_filter]

    results = []

    for class_name in classes_to_search:
        # Get all assets of this class under /Game/ (project only)
        asset_filter = unreal.ARFilter(
            class_names=[class_name],
            package_paths=['/Game'],
            recursive_paths=True,
        )
        assets = asset_registry.get_assets(asset_filter)

        for asset_data in assets:
            asset_path = str(asset_data.package_name)
            obj_name = str(asset_data.asset_name)

            # Apply text filter
            if filter_str:
                filter_lower = filter_str.lower()
                if (filter_lower not in asset_path.lower() and
                    filter_lower not in obj_name.lower()):
                    continue

            # Determine parent class
            parent_class = 'Unknown'
            try:
                # Try to get parent class from asset tags
                tag_value = asset_registry.get_tag_value_by_asset_data(
                    asset_data, 'ParentClass'
                )
                if tag_value:
                    # Format: /Script/Engine.Actor or /Game/Path.ClassName_C
                    parent_class = str(tag_value).split('.')[-1]
                    if parent_class.endswith("'"):
                        parent_class = parent_class[:-1]
            except Exception:
                pass

            # Determine blueprint type
            bp_type = blueprint_classes.get(class_name, 'Other')

            entry = {
                'assetPath': asset_path,
                'className': obj_name,
                'parentClass': parent_class,
                'type': bp_type,
            }

            results.append(entry)

    # Sort by asset path
    results.sort(key=lambda x: x['assetPath'])

    return results


def main():
    args = get_args()
    output_file = args.get('output_file', '')
    filter_str = args.get('filter', '')
    type_filter = args.get('type', '')

    data = list_blueprints(filter_str, type_filter)

    if output_file:
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
        unreal.log(f'[claude-unreal] Found {len(data)} blueprints, wrote to {output_file}')
    else:
        unreal.log('[claude-unreal] No output_file specified')


main()
