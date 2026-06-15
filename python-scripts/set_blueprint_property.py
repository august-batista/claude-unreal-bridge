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


def _split_floats(raw):
    return [float(x) for x in re.split(r'[,\s]+', raw.strip().strip('()')) if x]


def coerce_value(raw, current_value):
    """Coerce a raw string to match the type of current_value.

    Struct formats: Vector "X,Y,Z" · Rotator "Pitch,Yaw,Roll" · colors "R,G,B[,A]".
    Asset/object refs: any value starting with '/' is loaded via unreal.load_asset.
    """
    if isinstance(current_value, bool):
        return raw.strip().lower() in ('true', '1', 'yes')
    if isinstance(current_value, int):
        return int(float(raw))
    if isinstance(current_value, float):
        return float(raw)
    if isinstance(current_value, unreal.Vector):
        p = _split_floats(raw)
        return unreal.Vector(p[0], p[1], p[2])
    if isinstance(current_value, unreal.Rotator):
        p = _split_floats(raw)  # caller order: Pitch, Yaw, Roll
        r = unreal.Rotator()
        r.pitch, r.yaw, r.roll = p[0], p[1], p[2]
        return r
    if isinstance(current_value, unreal.LinearColor):
        p = _split_floats(raw)
        return unreal.LinearColor(p[0], p[1], p[2], p[3] if len(p) > 3 else 1.0)
    if isinstance(current_value, unreal.Color):
        p = [int(v) for v in _split_floats(raw)]
        c = unreal.Color()
        c.r, c.g, c.b, c.a = p[0], p[1], p[2], (p[3] if len(p) > 3 else 255)
        return c
    if isinstance(current_value, unreal.LightingChannels):
        parts = [p.strip().lower() in ('true', '1', 'yes') for p in re.split(r'[,\s]+', raw.strip()) if p]
        lc = unreal.LightingChannels()
        lc.set_editor_property('channel0', parts[0])
        lc.set_editor_property('channel1', parts[1] if len(parts) > 1 else False)
        lc.set_editor_property('channel2', parts[2] if len(parts) > 2 else False)
        return lc
    if isinstance(current_value, unreal.EnumBase):
        # Enum value by name, e.g. "Candelas" -> unreal.LightUnits.CANDELAS
        enum_name = re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', raw.strip()).upper()
        val = getattr(type(current_value), enum_name, None)
        if val is None:
            val = getattr(type(current_value), raw.strip().upper(), None)
        if val is None:
            raise ValueError(f'Unknown enum value "{raw}" for {type(current_value).__name__}')
        return val
    raw_s = raw.strip()
    # JSON array -> unreal.Array. "[[0,0],[1,0]]" => Array(IntPoint);
    # "[1,2,3]" => Array(int); '["a","b"]' => Array(str).
    if raw_s.startswith('['):
        import json as _json
        try:
            data = _json.loads(raw_s)
        except Exception as e:
            raise ValueError('value looks like a JSON array but failed to parse: %s' % e)
        if isinstance(data, list):
            if data and isinstance(data[0], list) and len(data[0]) == 2:
                arr = unreal.Array(unreal.IntPoint)
                for pair in data:
                    arr.append(unreal.IntPoint(int(pair[0]), int(pair[1])))
                return arr
            if all(isinstance(v, bool) for v in data):
                arr = unreal.Array(bool)
            elif all(isinstance(v, int) for v in data):
                arr = unreal.Array(int)
            elif all(isinstance(v, (int, float)) for v in data):
                arr = unreal.Array(float)
            else:
                arr = unreal.Array(str)
            for v in data:
                arr.append(v)
            return arr

    if raw_s.startswith('/') and (current_value is None or isinstance(current_value, (unreal.Object, type(None)))):
        # CDO reference, e.g. "/Game/X/Foo_DA.Default__Foo_DA_C" (object-pointer to a BP's defaults)
        if '.Default__' in raw_s:
            obj = unreal.load_object(None, raw_s)
            if obj is None:
                raise ValueError(f'Could not load CDO object "{raw_s}"')
            return obj
        # Class reference, e.g. "/Game/X/Foo_BP.Foo_BP_C" (TSubclassOf pins)
        if raw_s.endswith('_C'):
            cls = unreal.load_class(None, raw_s)
            if cls is None:
                raise ValueError(f'Could not load class "{raw_s}"')
            return cls
        loaded = unreal.load_asset(raw_s)
        if loaded is None:
            raise ValueError(f'Could not load asset "{raw_s}"')
        return loaded
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


def find_component_target(bp, component_ref):
    """
    Locate a component's edit target. `component_ref` may be either the component's
    VARIABLE NAME (e.g. "StageBackdrop" — preferred, unambiguous) or a UE class name
    (e.g. "CharacterMovementComponent"). Strategies, in order:
      1. SubobjectDataSubsystem variable-name match  (blueprint-added components)
      2. CDO get_editor_property                      (native/inherited components)
      3. SubobjectDataSubsystem class match           (blueprint-added, by class)
    Returns (target_object, label) or (None, error_string).
    """
    # Gather subobject templates once (the sanctioned editor API — the old
    # bp.simple_construction_script route is not exposed to UE Python).
    templates = []  # (variable_name, component_object)
    try:
        sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
        lib = unreal.SubobjectDataBlueprintFunctionLibrary
        for h in sds.k2_gather_subobject_data_for_blueprint(bp):
            d = lib.get_data(h)
            obj = lib.get_object(d)
            if obj is not None and isinstance(obj, unreal.ActorComponent):
                templates.append((str(lib.get_variable_name(d)), obj))
    except Exception:
        pass

    # Strategy 1: variable-name match ─────────────────────────────────────────
    for var_name, obj in templates:
        if var_name == component_ref:
            return obj, f'{component_ref} ({type(obj).__name__})'

    comp_class = getattr(unreal, component_ref, None)
    if comp_class is None:
        known = ', '.join(n for n, _ in templates) or '(none)'
        return None, (f'"{component_ref}" is neither a component variable name on this '
                      f'blueprint nor a UE class. Components present: {known}.')

    # Strategy 2: native component via get_editor_property on CDO ─────────────
    try:
        cdo = get_cdo(bp)
        for name in _name_candidates(component_ref):
            try:
                obj = cdo.get_editor_property(name)
                if obj is not None and isinstance(obj, comp_class):
                    return obj, component_ref
            except Exception:
                pass
    except Exception:
        pass

    # Strategy 3: class match over subobject templates ────────────────────────
    for var_name, obj in templates:
        if isinstance(obj, comp_class):
            return obj, f'{var_name} ({component_ref})'

    return None, f'No {component_ref} found on this blueprint (tried name, CDO, and subobject class match).'


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
        if isinstance(bp, unreal.Blueprint):
            try:
                target = get_cdo(bp)
            except Exception as e:
                return {'success': False, 'error': f'Failed to get CDO: {e}',
                        'component': None, 'property': property_name}
            target_label = '(blueprint CDO)'
        else:
            # Non-Blueprint asset (DataAsset instance, DataTable, etc.) — set
            # the property directly on the loaded object.
            target = bp
            target_label = '(%s asset)' % type(bp).__name__

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
    result = _apply_change(bp, component_class_name, property_name, value_str)
    if not result['success']:
        return result

    try:
        if isinstance(bp, unreal.Blueprint):
            unreal.BlueprintEditorLibrary.compile_blueprint(bp)
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
            if isinstance(bp, unreal.Blueprint):
                unreal.BlueprintEditorLibrary.compile_blueprint(bp)
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
