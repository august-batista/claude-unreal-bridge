"""
List the settable properties on a UE class (or blueprint component) with their
current CDO default values.

Reads arguments from builtins._claude_args:
  - class_name:   UE class to inspect, e.g. CharacterMovementComponent
  - output_file:  Where to write the JSON result

Returns:
  {
    "class_name": "CharacterMovementComponent",
    "properties": [
      { "name": "MaxWalkSpeed", "python_name": "max_walk_speed",
        "type": "float", "default": 600.0 },
      ...
    ],
    "error": null   (or a string on failure)
  }
"""

import json
import re
import traceback
import unreal


def get_args():
    import builtins
    return getattr(builtins, '_claude_args', {})


# Properties that are pure engine-internal bookkeeping and unhelpful to surface.
_BLOCKLIST = frozenset({
    'this', 'outer', 'class', 'name', 'world',
    'static_class', 'get_class', 'get_outer', 'get_name',
    'get_fname', 'get_full_name', 'get_path_name',
    'modify', 'get_typed_outer',
})

# Prefixes that indicate internal Python/UE binding helpers.
_BLOCKED_PREFIXES = ('_', 'cast', 'static_', 'find_', 'get_default')


def _is_useful(name):
    if name in _BLOCKLIST:
        return False
    for prefix in _BLOCKED_PREFIXES:
        if name.startswith(prefix):
            return False
    return True


def _to_pascal(snake):
    """Convert snake_case to PascalCase for display."""
    return ''.join(word.capitalize() for word in snake.split('_'))


def _repr_default(val):
    """Return a JSON-serialisable representation of a property default value."""
    if isinstance(val, (bool, int, float, str)):
        return val
    if val is None:
        return None
    return str(val)


def list_properties(class_name):
    # Resolve the UE class
    cls = getattr(unreal, class_name, None)
    if cls is None:
        return {
            'class_name': class_name,
            'properties': [],
            'error': (
                f'"{class_name}" not found in the unreal module. '
                f'Check the spelling — use the C++ class name, e.g. CharacterMovementComponent.'
            ),
        }

    # Get the CDO so we can read default values
    try:
        if hasattr(unreal, 'get_default_object'):
            cdo = unreal.get_default_object(cls)
        else:
            cdo = cls.get_default_object()
    except Exception as e:
        return {
            'class_name': class_name,
            'properties': [],
            'error': f'Could not get CDO for {class_name}: {e}',
        }

    if cdo is None:
        return {
            'class_name': class_name,
            'properties': [],
            'error': f'get_default_object returned None for {class_name}.',
        }

    # Enumerate all names on the CDO and probe each one
    properties = []
    for python_name in sorted(dir(cdo)):
        if not _is_useful(python_name):
            continue
        if callable(getattr(type(cdo), python_name, None)):
            # Skip methods — we only want data properties
            continue
        try:
            default = cdo.get_editor_property(python_name)
        except Exception:
            # get_editor_property failed — try raw attribute access as fallback
            try:
                default = getattr(cdo, python_name)
            except Exception:
                continue
            if callable(default):
                continue

        pascal_name = _to_pascal(python_name)
        properties.append({
            'name': pascal_name,
            'python_name': python_name,
            'type': type(default).__name__,
            'default': _repr_default(default),
        })

    return {
        'class_name': class_name,
        'properties': properties,
        'error': None,
    }


def main():
    args = get_args()
    class_name  = args.get('class_name', '')
    output_file = args.get('output_file', '')

    if not class_name:
        data = {'class_name': '', 'properties': [], 'error': 'No class_name provided'}
    else:
        try:
            data = list_properties(class_name)
        except Exception as e:
            data = {
                'class_name': class_name,
                'properties': [],
                'error': str(e),
                'traceback': traceback.format_exc(),
            }

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, default=str)
        unreal.log(f'[claude-unreal] list_class_properties written to {output_file}')
    else:
        unreal.log('[claude-unreal] No output_file specified')


main()
