"""
Search across all blueprints for a query string.
Runs inside the UE editor via -run=pythonscript.
Compatible with UE 5.7+ — uses T3D export for graph/variable data.

Reads arguments from builtins._claude_args:
  - output_file: Where to write the JSON output
  - query: Search term
  - scope: Search scope (all, functions, variables, nodes, comments)
"""

import json, re, os, tempfile, unreal


def get_args():
    import builtins
    return getattr(builtins, '_claude_args', {})


def export_t3d(bp):
    """Export blueprint to T3D text. Returns (text, error)."""
    fd, tmp = tempfile.mkstemp(suffix='.t3d')
    os.close(fd)
    try:
        task = unreal.AssetExportTask()
        task.object = bp
        task.filename = tmp
        task.automated = True
        task.prompt = False
        task.exporter = unreal.ObjectExporterT3D()
        unreal.Exporter.run_asset_export_task(task)
        with open(tmp, 'r', encoding='utf-8', errors='replace') as f:
            return f.read(), None
    except Exception as e:
        return None, str(e)
    finally:
        try: os.unlink(tmp)
        except Exception: pass


_RE_FIRST  = re.compile(r'^Begin Object\s+Class=([^\s]+)\s+Name="([^"]+)"', re.I)
_RE_SECOND = re.compile(r'^Begin Object\s+Name="([^"]+)"\s+ExportPath="[^"]*?\.([^.\']+)\'', re.I)
_RE_END    = re.compile(r'^End Object\s*$', re.I)
_RE_PROP   = re.compile(r'^(\w+(?:\(\d+\))?)\s*=\s*(.+)')

_INTERNAL = re.compile(r'^(?:ExecuteUbergraph_|InpActEvt_|.+_MERGED$|EdGraph_\d+$)')

_Q = '"'  # shorthand to avoid backslash in f-strings


def _node_title(cls, props):
    def ref_name(s):
        m = re.search(r'MemberName="([^"]+)"', s)
        return m.group(1) if m else ''
    if cls == 'K2Node_Event':
        return f'Event {ref_name(props.get("EventReference", ""))}'
    if cls == 'K2Node_CustomEvent':
        return f'Custom Event: {props.get("CustomFunctionName", "").strip(_Q)}'
    if cls == 'K2Node_FunctionEntry':
        return f'Function Entry: {props.get("CustomFunctionName", "").strip(_Q)}'
    if cls == 'K2Node_FunctionResult':
        return 'Return Node'
    if cls == 'K2Node_CallFunction':
        return ref_name(props.get('FunctionReference', '')) or 'Call Function'
    if cls == 'K2Node_VariableGet':
        return f'Get {ref_name(props.get("VariableReference", ""))}'
    if cls == 'K2Node_VariableSet':
        return f'Set {ref_name(props.get("VariableReference", ""))}'
    if cls == 'K2Node_IfThenElse':
        return 'Branch'
    if cls == 'K2Node_MacroInstance':
        m = re.search(r'MacroName="([^"]+)"', props.get('MacroGraphReference', ''))
        return m.group(1) if m else 'Macro'
    if cls == 'K2Node_EnhancedInputAction':
        ia = props.get('InputAction', '')
        m = re.search(r"'([^']+)'$", ia)
        return f'Input: {m.group(1).split(".")[-1]}' if m else 'Enhanced Input Action'
    if cls == 'K2Node_Timeline':
        return f'Timeline: {props.get("TimelineName", "").strip(_Q)}'
    if cls == 'EdGraphNode_Comment':
        return props.get('NodeComment', '').strip(_Q)
    return re.sub(r'^(?:K2Node_|EdGraphNode_)', '', cls)


def parse_t3d_for_search(content):
    """Parse T3D content. Returns {variables: [...], graphs: {name: {nodes, comments}}}."""
    result = {'variables': [], 'graphs': {}}
    stack = []

    for line in content.splitlines():
        s = line.strip()
        if not s:
            continue

        m2 = _RE_SECOND.match(s)
        if m2:
            name, cls = m2.group(1), m2.group(2)
            parent_graph = next(
                (e['name'] for e in reversed(stack) if e['cls'] == 'EdGraph' and not e['first']),
                None
            )
            stack.append({'name': name, 'cls': cls, 'first': False,
                          'props': {}, 'graph': parent_graph})
            continue

        m1 = _RE_FIRST.match(s)
        if m1:
            cls = m1.group(1).split('.')[-1]
            stack.append({'name': m1.group(2), 'cls': cls, 'first': True,
                          'props': {}, 'graph': None})
            continue

        if _RE_END.match(s):
            if not stack:
                continue
            e = stack.pop()
            if e['first']:
                # Variables are stored as NewVariables(N)=(...) on the first-pass Blueprint block
                for k, v in e['props'].items():
                    if k.startswith('NewVariables('):
                        nm = re.search(r'VarName="([^"]+)"', v)
                        cm = re.search(r'PinCategory="([^"]+)"', v)
                        if nm:
                            result['variables'].append({
                                'name': nm.group(1),
                                'type': cm.group(1) if cm else 'unknown',
                            })
            else:
                cls, gname = e['cls'], e['graph']
                if cls == 'EdGraph':
                    pass
                elif gname and not _INTERNAL.match(gname):
                    if gname not in result['graphs']:
                        result['graphs'][gname] = {'nodes': [], 'comments': []}
                    title = _node_title(cls, e['props'])
                    comment = e['props'].get('NodeComment', '').strip(_Q)
                    if cls == 'EdGraphNode_Comment':
                        result['graphs'][gname]['comments'].append(
                            {'title': title, 'comment': comment})
                    elif cls.startswith('K2Node_') or cls.startswith('AnimGraphNode_'):
                        result['graphs'][gname]['nodes'].append(
                            {'title': title, 'type': cls, 'comment': comment})
            continue

        if not stack:
            continue
        mp = _RE_PROP.match(s)
        if mp:
            stack[-1]['props'][mp.group(1)] = mp.group(2).rstrip()

    return result


def search_blueprint(asset_path, obj_name, query_lower, scope):
    """Search a single blueprint. Returns list of match dicts."""
    try:
        bp = unreal.EditorAssetLibrary.load_asset(asset_path)
        if not isinstance(bp, unreal.Blueprint):
            return []
        t3d, err = export_t3d(bp)
        if err or not t3d:
            return []
        parsed = parse_t3d_for_search(t3d)
    except Exception:
        return []

    matches = []

    if scope in ('all', 'variables'):
        for var in parsed['variables']:
            if query_lower in var['name'].lower():
                matches.append({
                    'type': 'variable',
                    'name': var['name'],
                    'context': f'Type: {var["type"]}',
                })

    for gname, gdata in parsed['graphs'].items():
        if scope in ('all', 'functions'):
            if query_lower in gname.lower():
                matches.append({
                    'type': 'function',
                    'name': gname,
                    'context': f'Function graph in {obj_name}',
                })

        if scope in ('all', 'nodes'):
            for node in gdata['nodes']:
                if query_lower in node['title'].lower() or query_lower in node['type'].lower():
                    matches.append({
                        'type': 'node',
                        'name': node['title'],
                        'context': f'In graph: {gname}',
                    })

        if scope in ('all', 'comments'):
            for node in gdata['nodes']:
                if node['comment'] and query_lower in node['comment'].lower():
                    matches.append({
                        'type': 'comment',
                        'name': node['comment'][:100],
                        'context': f'On node in graph: {gname}',
                    })
            for c in gdata['comments']:
                if query_lower in c['comment'].lower():
                    matches.append({
                        'type': 'comment',
                        'name': c['comment'][:100],
                        'context': f'Comment box in graph: {gname}',
                    })

    return matches


def search_blueprints(query, scope='all'):
    """Search all project blueprints for the given query."""
    query_lower = query.lower()
    asset_registry = unreal.AssetRegistryHelpers.get_asset_registry()
    asset_filter = unreal.ARFilter(
        class_names=['Blueprint', 'WidgetBlueprint', 'AnimBlueprint'],
        package_paths=['/Game'],
        recursive_paths=True,
    )
    assets = asset_registry.get_assets(asset_filter)

    results = []
    for asset_data in assets:
        asset_path = str(asset_data.package_name)
        obj_name = str(asset_data.asset_name)
        matches = search_blueprint(asset_path, obj_name, query_lower, scope)
        if matches:
            results.append({
                'assetPath': asset_path,
                'className': obj_name,
                'matches': matches,
            })

    return results


def main():
    args = get_args()
    output_file = args.get('output_file', '')
    query = args.get('query', '')
    scope = args.get('scope', 'all')

    data = search_blueprints(query, scope) if query else []

    if output_file:
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
        unreal.log(f'[claude-unreal] Search found matches in {len(data)} blueprints, wrote to {output_file}')
    else:
        unreal.log('[claude-unreal] No output_file specified')


main()
