"""
Set a property on a blueprint component (or on the blueprint CDO itself).

Reads arguments from builtins._claude_args:
  - asset_path:       Blueprint asset path, e.g. /Game/Blueprints/BP_Player
  - component_class:  UE class name, e.g. CharacterMovementComponent (optional)
                      If omitted, the property is set directly on the CDO.
  - property_name:    PascalCase or snake_case property name, e.g. MaxWalkSpeed
  - property_value:   String representation of the new value, e.g. "1800.0"
  - output_file:      Where to write the JSON result
"""

import json
import re
import traceback
import unreal


def get_args():
    import builtins
    return getattr(builtins, '_claude_args', {})


def to_snake_case(name):
    """Convert a UE property name (PascalCase or bBool prefix) to Python snake_case."""
    # Strip boolean 'b' prefix: bOrientRotationToMovement -> OrientRotationToMovement
    name = re.sub(r'^b([A-Z])', lambda m: m.group(1), name)
    # Insert underscores before uppercase letters
    name = re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', name)
    return name.lower()


def coerce_value(raw, current_value):
    """Coerce a raw string to match the type of current_value."""
    if isinstance(current_value, bool):
        return raw.strip().lower() in ('true', '1', 'yes')
    if isinstance(current_value, int):
        return int(float(raw))
    if isinstance(current_value, float):
        return float(raw)
    # Fallback: return as string
    return raw


def repr_value(v):
    """Return a JSON-serialisable representation of a UE value."""
    if isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


def get_cdo(bp):
    """Get the Class Default Object for a blueprint."""
    # generated_class may be a property or a callable depending on UE version
    gen_class = bp.generated_class
    if callable(gen_class):
        gen_class = gen_class()
    # Prefer the global unreal.get_default_object; fall back to method
    if hasattr(unreal, 'get_default_object'):
        return unreal.get_default_object(gen_class)
    return gen_class.get_default_object()


def _name_candidates(class_name):
    """
    Generate candidate editor-property names for a component class name.
    e.g. CharacterMovementComponent -> ['CharacterMovement', 'CharacterMovementComponent']
    """
    candidates = [class_name]
    # Strip trailing 'Component'
    if class_name.endswith('Component'):
        candidates.append(class_name[: -len('Component')])
    return candidates


def find_component_target(bp, component_class_name):
    """
    Try several strategies to locate a component's edit target:
      1. CDO get_editor_property (works for native/inherited components)
      2. SCS template nodes (works for blueprint-added components)
    Returns (target_object, label) or (None, error_string).
    """
    comp_class = getattr(unreal, component_class_name, None)
    if comp_class is None:
        return None, f'Unknown UE class: "{component_class_name}". Check spelling (e.g. CharacterMovementComponent).'

    # Strategy 1: native component via get_editor_property on CDO ─────────────
    try:
        cdo = get_cdo(bp)
        for name in _name_candidates(component_class_name):
            try:
                obj = cdo.get_editor_property(name)
                if obj is not None and isinstance(obj, comp_class):
                    return obj, component_class_name
            except Exception:
                pass
    except Exception:
        pass

    # Strategy 2: SCS template nodes ─────────────────────────────────────────
    try:
        scs = bp.simple_construction_script
        if scs:
            for node in scs.get_all_nodes():
                if node.component_class and issubclass(node.component_class, comp_class):
                    return node.component_template, component_class_name
    except Exception:
        pass

    return None, f'No {component_class_name} found on this blueprint (tried CDO property lookup and SCS nodes).'


def _apply_change(bp, component_class_name, property_name, value_str):
    """
    Apply a single property change to an already-loaded blueprint object.
    Does NOT save — callers are responsible for saving after all changes.
    Returns a result dict with success/error info.
    """
    # ── Resolve target object (component or CDO) ──────────────────────────────
    if component_class_name:
        target, label_or_err = find_component_target(bp, component_class_name)
        if target is None:
            return {'success': False, 'error': label_or_err,
                    'component': component_class_name, 'property': property_name}
        target_label = label_or_err
    else:
        try:
            target = get_cdo(bp)
        except Exception as e:
            return {'success': False, 'error': f'Failed to get CDO: {e}',
                    'component': None, 'property': property_name}
        target_label = '(blueprint CDO)'

    # ── Read current value ────────────────────────────────────────────────────
    try:
        old_value = target.get_editor_property(property_name)
    except Exception:
        snake_prop = to_snake_case(property_name)
        try:
            old_value = getattr(target, snake_prop)
            property_name = snake_prop
        except AttributeError:
            return {
                'success': False,
                'error': (
                    f'Property "{property_name}" not found on {type(target).__name__}. '
                    f'Also tried snake_case "{snake_prop}".'
                ),
                'component': target_label,
                'property': property_name,
            }

    # ── Coerce and set ────────────────────────────────────────────────────────
    try:
        new_value = coerce_value(value_str, old_value)
        target.set_editor_property(property_name, new_value)
    except Exception as e:
        return {
            'success': False,
            'error': f'Failed to set "{property_name}" to "{value_str}": {e}',
            'component': target_label,
            'property': property_name,
        }

    return {
        'success': True,
        'component': target_label,
        'property': property_name,
        'old_value': repr_value(old_value),
        'new_value': repr_value(new_value),
    }


def set_property(asset_path, component_class_name, property_name, value_str):
    """Apply a single property change and save."""
    bp = unreal.EditorAssetLibrary.load_asset(asset_path)
    if bp is None:
        return {'success': False, 'error': f'Cannot load asset: {asset_path}'}
    if not isinstance(bp, unreal.Blueprint):
        return {'success': False, 'error': f'Asset is not a Blueprint: {type(bp).__name__}'}

    result = _apply_change(bp, component_class_name, property_name, value_str)
    if not result['success']:
        return result

    try:
        unreal.EditorAssetLibrary.save_asset(asset_path, only_if_is_dirty=False)
    except Exception as e:
        return {'success': False, 'error': f'Property set but save failed: {e}'}

    result['asset_path'] = asset_path
    return result


def set_properties_batch(asset_path, changes):
    """
    Apply multiple property changes to one blueprint in a single UE session.
    Saves once after all changes, regardless of how many succeed or fail.

    `changes` is a list of dicts with keys:
      - component_class  (optional str)
      - property_name    (str)
      - property_value   (str)
    """
    bp = unreal.EditorAssetLibrary.load_asset(asset_path)
    if bp is None:
        return {'success': False, 'error': f'Cannot load asset: {asset_path}', 'results': []}
    if not isinstance(bp, unreal.Blueprint):
        return {'success': False, 'error': f'Not a Blueprint: {type(bp).__name__}', 'results': []}

    results = []
    any_success = False
    for change in changes:
        r = _apply_change(
            bp,
            change.get('component_class', ''),
            change.get('property_name', ''),
            change.get('property_value', ''),
        )
        r['asset_path'] = asset_path
        results.append(r)
        if r['success']:
            any_success = True

    saved = False
    save_error = None
    if any_success:
        try:
            unreal.EditorAssetLibrary.save_asset(asset_path, only_if_is_dirty=False)
            saved = True
        except Exception as e:
            save_error = str(e)

    return {
        'success': any_success and saved,
        'asset_path': asset_path,
        'saved': saved,
        'save_error': save_error,
        'results': results,
    }


def main():
    args = get_args()
    asset_path      = args.get('asset_path', '')
    output_file     = args.get('output_file', '')

    # Batch mode: a JSON-encoded list of changes is passed as 'changes'
    changes_raw = args.get('changes', '')

    if not asset_path:
        data = {'success': False, 'error': 'No asset_path provided'}
    elif changes_raw:
        # ── Batch mode ────────────────────────────────────────────────────────
        try:
            changes = json.loads(changes_raw) if isinstance(changes_raw, str) else changes_raw
            data = set_properties_batch(asset_path, changes)
        except Exception as e:
            data = {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}
    else:
        # ── Single-property mode ──────────────────────────────────────────────
        component_class = args.get('component_class', '')
        property_name   = args.get('property_name', '')
        property_value  = args.get('property_value', '')

        if not property_name:
            data = {'success': False, 'error': 'No property_name provided'}
        elif property_value == '':
            data = {'success': False, 'error': 'No property_value provided'}
        else:
            try:
                data = set_property(asset_path, component_class, property_name, property_value)
            except Exception as e:
                data = {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, default=str)
        unreal.log(f'[claude-unreal] set_blueprint_property result written to {output_file}')
    else:
        unreal.log('[claude-unreal] No output_file specified')


main()
