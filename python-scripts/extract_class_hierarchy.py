"""
Extract the class hierarchy of all blueprints in a project.
Runs inside the UE editor via -run=pythonscript.

Reads arguments from builtins._claude_args:
  - output_file: Where to write the JSON output
"""

import json
import unreal


def get_args():
    import builtins
    return getattr(builtins, '_claude_args', {})


def extract_hierarchy():
    """Build a class hierarchy tree from all project blueprints."""
    asset_registry = unreal.AssetRegistryHelpers.get_asset_registry()

    asset_filter = unreal.ARFilter(
        class_names=['Blueprint', 'WidgetBlueprint', 'AnimBlueprint'],
        package_paths=['/Game'],
        recursive_paths=True,
    )
    assets = asset_registry.get_assets(asset_filter)

    # Build parent -> children map
    # Key: parent class name, Value: list of (child class name, asset path)
    parent_map = {}
    all_classes = set()

    for asset_data in assets:
        asset_path = str(asset_data.package_name)
        obj_name = str(asset_data.asset_name)

        parent_class = 'Object'
        try:
            tag_value = asset_registry.get_tag_value_by_asset_data(
                asset_data, 'ParentClass'
            )
            if tag_value:
                parent_class = str(tag_value).split('.')[-1]
                if parent_class.endswith("'"):
                    parent_class = parent_class[:-1]
                # Remove _C suffix from generated class names
                if parent_class.endswith('_C'):
                    parent_class = parent_class[:-2]
        except Exception:
            pass

        if parent_class not in parent_map:
            parent_map[parent_class] = []

        parent_map[parent_class].append({
            'className': obj_name,
            'assetPath': asset_path,
        })
        all_classes.add(obj_name)

    # Build tree starting from root classes (those whose parents aren't in our set)
    roots = []
    for parent_name, children in parent_map.items():
        if parent_name not in all_classes:
            # This parent is a C++ or engine class (root of our tree)
            root_node = build_tree_node(parent_name, None, parent_map, all_classes)
            roots.append(root_node)

    # Sort roots by class name
    roots.sort(key=lambda n: n['className'])

    return roots


def build_tree_node(class_name, asset_path, parent_map, all_classes):
    """Recursively build a hierarchy tree node."""
    node = {
        'className': class_name,
        'children': [],
    }
    if asset_path:
        node['assetPath'] = asset_path

    # Find children of this class
    children = parent_map.get(class_name, [])
    for child in sorted(children, key=lambda c: c['className']):
        child_node = build_tree_node(
            child['className'],
            child['assetPath'],
            parent_map,
            all_classes,
        )
        node['children'].append(child_node)

    return node


def main():
    args = get_args()
    output_file = args.get('output_file', '')

    data = extract_hierarchy()

    if output_file:
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
        unreal.log(f'[claude-unreal] Wrote hierarchy with {len(data)} root classes to {output_file}')
    else:
        unreal.log('[claude-unreal] No output_file specified')


main()
