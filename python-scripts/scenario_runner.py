"""
In-game scenario runner for claude-unreal-bridge.

Loaded by the bridge via:

    UnrealEditor-Cmd <project> -game <map>
      -ExecCmds="py.execfile <path-to-this-script>"
      ... (other headless flags)

with env:
    CLAUDE_SCENARIO_JSON    path to a JSON file containing the step list
    CLAUDE_SCENARIO_RESULT  path to write per-step trace JSON when done

The runner:
  1. Registers a Slate post-tick callback (fires every frame even in
     -nullrhi -unattended).
  2. Waits for the game world + player controller to come up.
  3. Walks the step list, processing one step per tick until the step's
     handler returns done=True.
  4. Writes a result JSON with per-step timing + outcome.
  5. Issues a clean Quit (or relies on the bridge's timeout backstop).

Step types — see mcp-server/src/types/scenario.ts for the canonical
schema. This file implements the in-engine half.
"""

import json
import os
import re
import sys
import time
import traceback

import unreal


# --------------------------------------------------------------------------
# Configuration & state
# --------------------------------------------------------------------------

SCENARIO_JSON = os.environ.get("CLAUDE_SCENARIO_JSON", "")
RESULT_JSON = os.environ.get("CLAUDE_SCENARIO_RESULT", "")
LOG_PATH = os.environ.get("CLAUDE_SCENARIO_LOG", "")
# When set, the runner waits for an editor world, triggers PIE
# programmatically, and only starts running steps once the PIE world is
# active. Used by run-scenario when steps include `playRecording`.
AUTOSTART_PIE = os.environ.get("CLAUDE_SCENARIO_AUTOSTART_PIE", "") not in ("", "0", "false", "False")


def _log(msg):
    """Stamped log line — visible in the engine log under LogPython."""
    unreal.log("[ClaudeScenario] " + str(msg))


def _err(msg):
    unreal.log_error("[ClaudeScenario] " + str(msg))


try:
    with open(SCENARIO_JSON, "r") as _f:
        STEPS = json.load(_f)
except Exception as _e:
    _err("Failed to load scenario JSON: %s" % _e)
    STEPS = []

# Per-run state, all mutable.
state = {
    "step_idx": 0,
    "sub": None,           # per-step transient state (start time, log scan pos, etc.)
    "shutting_down": False,
    "tick_handle": None,
    "log_pos": 0,          # byte offset into the live log we've scanned through
    "started_wall_at": time.time(),
    "results": [],         # ScenarioStepResult[]
    "world_ready_at": None,
    "tick_count": 0,
    "last_heartbeat_tick": 0,
    # PIE auto-start state
    "pie_triggered": False,
    "pie_active_at": None,
}


# --------------------------------------------------------------------------
# UE world plumbing
# --------------------------------------------------------------------------

def _player_controller():
    """Return the local player controller, or None if not yet spawned.
    Uses our cached world reference so the WorldContextObject is valid."""
    w = _world()
    if not w:
        return None
    try:
        return unreal.GameplayStatics.get_player_controller(w, 0)
    except Exception:
        return None


def _player_pawn():
    """Return the pawn the local player controls, or None.

    The Python binding name for APlayerController::K2_GetPawn varies
    across UE versions. Try several known forms.
    """
    pc = _player_controller()
    if not pc:
        return None
    # Try several known Python binding names.
    for name in ("k2_get_pawn", "get_pawn", "get_controlled_pawn", "controlled_pawn"):
        getter = getattr(pc, name, None)
        if getter:
            try:
                return getter() if callable(getter) else getter
            except Exception:
                pass
    # Fallback: GameplayStatics.get_player_pawn
    try:
        w = _world()
        if w:
            return unreal.GameplayStatics.get_player_pawn(w, 0)
    except Exception:
        pass
    return None


_world_cache = {"world": None, "diag_logged": False}


def _world():
    """Find the active Game world.

    `UGameplayStatics::GetPlayerController(None, 0)` returns null in -game
    mode because it needs a valid WorldContextObject to resolve the world.
    So we have to find the world via other paths before we can use any of
    the WorldContext-flavoured APIs.

    Caches the first successful result. Logs which strategy worked once.
    """
    if _world_cache["world"] is not None:
        try:
            # Liveness check — invalid worlds raise / return 0.
            unreal.GameplayStatics.get_time_seconds(_world_cache["world"])
            return _world_cache["world"]
        except Exception:
            _world_cache["world"] = None

    diag = []

    def _log_strategy(name, ok, detail=""):
        diag.append("%s: %s%s" % (name, "OK" if ok else "no", " (" + detail + ")" if detail else ""))

    # Strategy 0: ClaudeUnrealBridgeRuntime helper (preferred — purpose-built
    # for this exact problem; lives in the editor-side companion plugin).
    try:
        lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
        if lib:
            w = lib.get_game_world()
            if w:
                _world_cache["world"] = w
                _log_strategy("ClaudeRuntimeLibrary.get_game_world", True, "")
                if not _world_cache["diag_logged"]:
                    _log("world finder strategies: " + " | ".join(diag))
                    _world_cache["diag_logged"] = True
                return w
            _log_strategy("ClaudeRuntimeLibrary.get_game_world", False, "returned None")
        else:
            _log_strategy("ClaudeRuntimeLibrary", False, "not on unreal module (Runtime submodule not loaded — install/update ClaudeUnrealBridge plugin)")
    except Exception as e:
        _log_strategy("ClaudeRuntimeLibrary", False, "exception: %s" % e)

    # Strategy 1: unreal.find_objects(class) — exists in some UE 5.x versions.
    for fname in ("find_objects", "find_objects_of_class"):
        finder = getattr(unreal, fname, None)
        if not finder:
            _log_strategy(fname, False, "not in module")
            continue
        try:
            results = finder(unreal.World)
            count = len(list(results)) if results is not None else 0
            _log_strategy(fname, count > 0, "found %d worlds" % count)
            if count > 0:
                # Re-iterate (we may have consumed the iterator above)
                results = finder(unreal.World)
                # Prefer Game/PIE type
                game = None
                first = None
                for w in results:
                    if first is None:
                        first = w
                    wt_val = -1
                    try:
                        wt_val = int(getattr(w, "world_type", -1))
                    except Exception:
                        pass
                    if wt_val in (1, 3):
                        game = w
                        break
                chosen = game or first
                if chosen:
                    _world_cache["world"] = chosen
                    if not _world_cache["diag_logged"]:
                        _log("world finder strategies: " + " | ".join(diag))
                        _world_cache["diag_logged"] = True
                    return chosen
        except Exception as e:
            _log_strategy(fname, False, "raised: %s" % e)

    # Strategy 2: garbage-collector walk. UE's Python plugin wraps UObjects
    # in Python proxies; the proxies are reachable through gc. Slower than
    # a native iterator but works without engine support.
    try:
        import gc as _gc
        seen = 0
        for obj in _gc.get_objects():
            if isinstance(obj, unreal.World):
                seen += 1
                try:
                    wt_val = int(getattr(obj, "world_type", -1))
                except Exception:
                    wt_val = -1
                if wt_val in (1, 3):
                    _world_cache["world"] = obj
                    _log_strategy("gc.get_objects", True, "found Game world after scanning")
                    if not _world_cache["diag_logged"]:
                        _log("world finder strategies: " + " | ".join(diag))
                        _world_cache["diag_logged"] = True
                    return obj
        _log_strategy("gc.get_objects", seen > 0, "found %d UWorlds, none Game-type" % seen)
    except Exception as e:
        _log_strategy("gc.get_objects", False, "raised: %s" % e)

    # Strategies 3 / 3b are editor-only. In -game mode there is no editor
    # subsystem, and calling EditorLevelLibrary.get_editor_world() in -game
    # mode SIGSEGVs inside FSubsystemCollectionBase. Gate on a cheap is_editor
    # probe (Python's `unreal.is_editor()` exists in 5.5+; falls back to
    # checking for a known editor-only subsystem).
    def _is_editor_context():
        fn = getattr(unreal, "is_editor", None)
        if callable(fn):
            try:
                return bool(fn())
            except Exception:
                pass
        # Fallback: presence of any editor subsystem implies editor binary.
        try:
            return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem) is not None
        except Exception:
            return False

    if _is_editor_context():
        # Strategy 3: editor subsystem — may work even in -game since the
        # editor binary is running with a single world context.
        try:
            eus = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
            if eus:
                getter = getattr(eus, "get_game_world", None) or getattr(eus, "get_editor_world", None)
                if getter:
                    w = getter()
                    if w:
                        _world_cache["world"] = w
                        _log_strategy("UnrealEditorSubsystem", True, getter.__name__)
                        if not _world_cache["diag_logged"]:
                            _log("world finder strategies: " + " | ".join(diag))
                            _world_cache["diag_logged"] = True
                        return w
                _log_strategy("UnrealEditorSubsystem", False, "no getter")
            else:
                _log_strategy("UnrealEditorSubsystem", False, "subsystem None")
        except Exception as e:
            _log_strategy("UnrealEditorSubsystem", False, "exception: %s" % e)

        # Strategy 3b: EditorLevelLibrary (legacy editor utility) — broadly
        # works in editor mode (whether PIE is up or not).
        try:
            ell = getattr(unreal, "EditorLevelLibrary", None)
            if ell:
                getter = getattr(ell, "get_editor_world", None) or getattr(ell, "get_game_world", None)
                if getter:
                    w = getter()
                    if w:
                        _world_cache["world"] = w
                        _log_strategy("EditorLevelLibrary", True, getter.__name__)
                        if not _world_cache["diag_logged"]:
                            _log("world finder strategies: " + " | ".join(diag))
                            _world_cache["diag_logged"] = True
                        return w
                _log_strategy("EditorLevelLibrary", False, "no getter")
        except Exception as e:
            _log_strategy("EditorLevelLibrary", False, "exception: %s" % e)
    else:
        _log_strategy("EditorSubsystem strategies", False, "skipped: not editor context (-game mode)")

    # Strategy 4: find_object by common name. The runtime world is typically
    # named after the .umap basename (e.g. /Engine/Maps/X.X loads to "X").
    map_candidates = ["Game", "OpenWorld", "DevLevel", "Sandbox", "MainMenu", "PersistentLevel"]
    for name in map_candidates:
        try:
            obj = unreal.find_object(None, name, unreal.World)
            if obj is None:
                # Try without type filter
                obj = unreal.find_object(None, name)
            if obj and isinstance(obj, unreal.World):
                _world_cache["world"] = obj
                _log_strategy("find_object", True, "name=" + name)
                if not _world_cache["diag_logged"]:
                    _log("world finder strategies: " + " | ".join(diag))
                    _world_cache["diag_logged"] = True
                return obj
        except Exception:
            pass
    _log_strategy("find_object", False, "tried %d common names" % len(map_candidates))

    # Strategy 5: PlayerController with None context — final defensive try.
    try:
        pc = unreal.GameplayStatics.get_player_controller(None, 0)
        if pc:
            w = pc.get_world()
            if w:
                _world_cache["world"] = w
                _log_strategy("GameplayStatics+None", True, "")
                if not _world_cache["diag_logged"]:
                    _log("world finder strategies: " + " | ".join(diag))
                    _world_cache["diag_logged"] = True
                return w
    except Exception:
        _log_strategy("GameplayStatics+None", False, "exception")

    # No world. Log diagnostic once.
    if not _world_cache["diag_logged"]:
        _log("world finder strategies (all failed): " + " | ".join(diag))
        _world_cache["diag_logged"] = True
    return None


def _game_seconds():
    """Game-time seconds if we have a world, else wall-clock seconds since
    the runner started. Always monotonic, always returns a positive value
    after the first tick."""
    w = _world()
    if w:
        try:
            return unreal.GameplayStatics.get_time_seconds(w)
        except Exception:
            pass
    return time.time() - state["started_wall_at"]


def _pie_world():
    """Return the active PIE world specifically, or None.

    `EditorLevelLibrary.get_game_world()` returns the PIE world when PIE
    is active in the editor (or the standalone game world in -game), and
    None when only an editor world exists. That's the cleanest way to
    tell PIE-active from editor-idle.
    """
    ell = getattr(unreal, "EditorLevelLibrary", None)
    if ell:
        try:
            getter = getattr(ell, "get_game_world", None)
            if getter:
                w = getter()
                if w:
                    return w
        except Exception:
            pass
    return None


def _has_pie_world():
    return _pie_world() is not None


def _has_editor_world():
    """True if ANY world is loaded (Editor, Game, or PIE). Used as the
    trigger for PIE auto-start in editor mode."""
    return _world() is not None


_pie_diag_logged = {"done": False}


def _try_start_pie():
    """Trigger PIE via whichever editor API is available. Returns True if a
    call was made (success isn't guaranteed — caller polls for PIE world).
    First call dumps what's actually exposed so we can iterate quickly."""

    # One-shot diagnostic — log what's available on LevelEditorSubsystem +
    # related play-mode APIs so we know which methods to call.
    if not _pie_diag_logged["done"]:
        _pie_diag_logged["done"] = True
        try:
            les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
            if les:
                play_methods = [m for m in sorted(dir(les))
                                if "play" in m.lower() or "pie" in m.lower() or "simulate" in m.lower()]
                _log("LevelEditorSubsystem play-mode methods: %s" % play_methods)
            else:
                _log("LevelEditorSubsystem returned None")
        except Exception as e:
            _log("LevelEditorSubsystem diag raised: %s" % e)
        # Check what struct types are exposed for PIE params
        candidates = ["RequestPlaySessionParams", "PlaySessionRequestParams",
                      "PlayInEditorOverrides", "EditorPlaySettings"]
        present = [c for c in candidates if hasattr(unreal, c)]
        _log("PIE-related struct classes on unreal: %s" % present)

    try:
        les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    except Exception as e:
        les = None
        _log("LevelEditorSubsystem unavailable: %s" % e)

    # Preferred: editor_request_begin_play — starts real PIE (spawns player
    # controller + binds IMC), no params needed in UE 5.7.
    if les and hasattr(les, "editor_request_begin_play"):
        try:
            les.editor_request_begin_play()
            _log("triggered real PIE via LevelEditorSubsystem.editor_request_begin_play")
            return True
        except Exception as e:
            _log("editor_request_begin_play raised: %s" % e)

    # Degraded fallback: Simulate mode — no PlayerController, no IMC.
    # Won't help replay but at least gives a tick.
    if les and hasattr(les, "editor_play_simulate"):
        try:
            les.editor_play_simulate()
            _log("triggered Simulate via LevelEditorSubsystem.editor_play_simulate (NOT real PIE — degraded)")
            return True
        except Exception as e:
            _log("editor_play_simulate raised: %s" % e)

    return False


def _end_pie():
    """Stop the active PIE session. Editor stays alive — call quit_game on
    the editor world afterwards to terminate the whole process."""
    try:
        les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
        if les and hasattr(les, "editor_request_end_play"):
            les.editor_request_end_play()
            _log("requested end PIE session")
            return True
    except Exception as e:
        _log("editor_request_end_play raised: %s" % e)
    return False


def _enhanced_input_subsystem():
    """Return the local player's EnhancedInputLocalPlayerSubsystem.

    Prefers the ClaudeUnrealBridgeRuntime helper which finds the world,
    game instance, local player, and subsystem in C++ — bypasses Python's
    inability to chain through these in -game mode. Falls back to manual
    chain if the helper isn't loaded.
    """
    # Preferred path: editor-side plugin's runtime helper.
    try:
        lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
        if lib:
            sub = lib.get_local_player_enhanced_input_subsystem()
            if sub:
                return sub
    except Exception:
        pass

    # Manual fallback. Only works if _world() and _player_controller()
    # produced live references.
    pc = _player_controller()
    if not pc:
        return None
    lp = pc.get_local_player()
    if not lp:
        return None
    try:
        return lp.get_subsystem(unreal.EnhancedInputLocalPlayerSubsystem)
    except Exception:
        return None


def _resolve_input_action(name_or_path):
    """Load a UInputAction by asset path or short name.

    Asset paths use the `/Game/...` form. Short names (`IA_Move`) are
    looked up via the asset registry — slower but more ergonomic for
    the step author.
    """
    if not name_or_path:
        return None
    if name_or_path.startswith("/"):
        # `unreal.load_object` returns None for missing paths instead of
        # raising — fine for our purposes, we just report and skip.
        return unreal.load_object(None, name_or_path)
    # Short-name lookup via asset registry, restricted to InputAction class.
    try:
        ar = unreal.AssetRegistryHelpers.get_asset_registry()
        filt = unreal.ARFilter(
            class_names=["InputAction"],
            recursive_paths=True,
            package_paths=["/Game"],
        )
        for asset in ar.get_assets(filt):
            if str(asset.asset_name) == name_or_path:
                return unreal.load_object(None, str(asset.package_name) + "." + str(asset.asset_name))
    except Exception as e:
        _err("Asset registry lookup failed for %r: %s" % (name_or_path, e))
    return None


def _resolve_input_mapping_context(name_or_path):
    """Load a UInputMappingContext by asset path or short name.

    Same shape as `_resolve_input_action`, but filtered to the
    InputMappingContext class. `/Game/...` paths load directly; short
    names go through the asset registry.
    """
    if not name_or_path:
        return None
    if name_or_path.startswith("/"):
        return unreal.load_object(None, name_or_path)
    try:
        ar = unreal.AssetRegistryHelpers.get_asset_registry()
        filt = unreal.ARFilter(
            class_names=["InputMappingContext"],
            recursive_paths=True,
            package_paths=["/Game"],
        )
        for asset in ar.get_assets(filt):
            if str(asset.asset_name) == name_or_path:
                return unreal.load_object(None, str(asset.package_name) + "." + str(asset.asset_name))
    except Exception as e:
        _err("IMC asset registry lookup failed for %r: %s" % (name_or_path, e))
    return None


def _bind_input_mapping_contexts(names_or_paths, priority=0):
    """Add a list of UInputMappingContexts to the local player's
    EnhancedInputLocalPlayerSubsystem.

    Returns a list of `(name, ok, detail)` triples so callers can fold
    the outcome into a step trace. Logs each attempt. Per-IMC exceptions
    are caught so one bad name doesn't abort the others.
    """
    results = []
    if not names_or_paths:
        return results
    sub = _enhanced_input_subsystem()
    if not sub:
        _log("IMC bind: no EnhancedInputLocalPlayerSubsystem available; skipping %d IMC(s)"
             % len(names_or_paths))
        for n in names_or_paths:
            results.append((n, False, "no subsystem"))
        return results
    for name in names_or_paths:
        try:
            imc = _resolve_input_mapping_context(name)
            if imc is None:
                _log("IMC bind: could not resolve %r" % name)
                results.append((name, False, "not found"))
                continue
            sub.add_mapping_context(imc, priority)
            _log("IMC bound: %s (priority %d)" % (name, priority))
            results.append((name, True, None))
        except Exception as e:
            _log("IMC bind: %r raised: %s" % (name, e))
            results.append((name, False, "raised: %s" % e))
    return results


def _discover_pawn_default_imcs(pawn):
    """Best-effort: introspect a pawn's class-default subobjects for an
    IMC reference. Tries common UProperty names. Returns a list of
    `/Game/...` paths (possibly empty)."""
    if not pawn:
        return []
    try:
        cdo = pawn.get_class().get_default_object()
    except Exception:
        return []
    # Property name candidates, in priority order. UE Python's pascal-to-
    # snake conversion is consistent for these.
    name_candidates = [
        "default_mapping_context",
        "mapping_context",
        "default_input_mapping_context",
        "input_mapping_context",
        "mapping_contexts",
        "default_mapping_contexts",
        "input_mapping_contexts",
    ]
    found_paths = []
    for prop_name in name_candidates:
        try:
            val = cdo.get_editor_property(prop_name)
        except Exception:
            continue
        if val is None:
            continue
        # Either a single IMC asset or an iterable of them. Both shapes
        # show up across projects.
        if hasattr(val, "get_path_name"):
            found_paths.append(val.get_path_name())
            _log("IMC discover: pawn.%s -> %s" % (prop_name, val.get_path_name()))
        elif hasattr(val, "__iter__"):
            for item in val:
                if item and hasattr(item, "get_path_name"):
                    found_paths.append(item.get_path_name())
                    _log("IMC discover: pawn.%s[] -> %s" % (prop_name, item.get_path_name()))
        if found_paths:
            break
    return found_paths


def _action_value_type(kind):
    """Resolve an EInputActionValueType enum value by trying several naming
    conventions. UE Python's pascal-to-snake generator behaves differently
    across versions for enum names containing digits."""
    candidates = {
        "boolean": ("BOOLEAN", "Boolean"),
        "axis1d":  ("AXIS1_D", "AXIS_1D", "AXIS1D", "Axis1D"),
        "axis2d":  ("AXIS2_D", "AXIS_2D", "AXIS2D", "Axis2D"),
        "axis3d":  ("AXIS3_D", "AXIS_3D", "AXIS3D", "Axis3D"),
    }
    for name in candidates[kind]:
        v = getattr(unreal.InputActionValueType, name, None)
        if v is not None:
            return v
    # Surface the available enum values for diagnosis on first miss.
    attrs = [a for a in dir(unreal.InputActionValueType) if not a.startswith("_")]
    raise RuntimeError("InputActionValueType.%s not found; available: %s" % (kind, attrs))


def _make_action_value(val):
    """Build a UE FInputActionValue from a Python value via
    UEnhancedInputLibrary::MakeInputActionValueOfType(x, y, z, ValueType).

    Python type → action value type:
        bool / int / float          → Axis1D with x=val
        [x, y]                      → Axis2D
        [x, y, z]                   → Axis3D
        None / missing              → Boolean x=1.0 (button press)
    """
    if val is None:
        x, y, z, vt = 1.0, 0.0, 0.0, _action_value_type("boolean")
    elif isinstance(val, (int, float)):
        x, y, z, vt = float(val), 0.0, 0.0, _action_value_type("axis1d")
    elif isinstance(val, (list, tuple)):
        if len(val) == 2:
            x, y, z, vt = float(val[0]), float(val[1]), 0.0, _action_value_type("axis2d")
        elif len(val) == 3:
            x, y, z, vt = float(val[0]), float(val[1]), float(val[2]), _action_value_type("axis3d")
        else:
            x, y, z, vt = 1.0, 0.0, 0.0, _action_value_type("boolean")
    else:
        x, y, z, vt = 1.0, 0.0, 0.0, _action_value_type("boolean")

    # The Python-exposed constructor mirrors UE's BP factory
    # `MakeInputActionValueOfType(X, Y, Z, ValueType)`.
    return unreal.InputActionValue(x, y, z, vt)


# --------------------------------------------------------------------------
# Step handlers — each returns (done: bool, outcome: str, detail: str|None)
# --------------------------------------------------------------------------

def _handle_exec(step):
    cmd = step.get("cmd", "")
    w = _world()
    try:
        unreal.SystemLibrary.execute_console_command(w, cmd)
        return True, "ok", None
    except Exception as e:
        return True, "error", "execute_console_command raised: %s" % e


def _handle_wait(step):
    # Wall-clock, NOT game time: the runner ticks on Slate post-tick, which
    # keeps firing while the game is paused (e.g. the inventory menu). Game-
    # time waits would hang forever there.
    elapsed = time.time() - state["sub"]["started_at_wall"]
    if elapsed >= float(step.get("seconds", 0)):
        return True, "ok", None
    return False, "ok", None


def _handle_wait_for_log(step):
    pattern_str = step.get("pattern", "")
    timeout = float(step.get("timeoutSec", 30))

    # Tail any new bytes since last scan.
    new_text = ""
    if LOG_PATH:
        try:
            with open(LOG_PATH, "rb") as f:
                f.seek(state["log_pos"])
                buf = f.read()
                state["log_pos"] = f.tell()
                new_text = buf.decode("utf-8", errors="replace")
        except Exception:
            pass

    if pattern_str and new_text:
        try:
            if re.search(pattern_str, new_text, re.IGNORECASE):
                return True, "matched", pattern_str
        except re.error as e:
            return True, "error", "bad regex: %s" % e

    elapsed = time.time() - state["sub"]["started_at_wall"]
    if elapsed >= timeout:
        return True, "timedOut", "pattern=%s timeout=%.1fs" % (pattern_str, timeout)
    return False, "ok", None


def _handle_inject(step):
    ia = _resolve_input_action(step.get("action", ""))
    if not ia:
        return True, "error", "could not resolve InputAction %r" % step.get("action")

    subsys = _enhanced_input_subsystem()
    if not subsys:
        return True, "error", "no EnhancedInputLocalPlayerSubsystem (no local player?)"

    value = _make_action_value(step.get("value"))
    try:
        subsys.inject_input_for_action(ia, value, [], [])
    except Exception as e:
        return True, "error", "inject_input_for_action raised: %s" % e

    hold = float(step.get("holdSec", 0) or 0)
    if hold <= 0:
        # Single-tick discrete press.
        return True, "ok", None

    elapsed = _game_seconds() - state["sub"]["started_at_game_sec"]
    if elapsed >= hold:
        return True, "ok", "held %.2fs" % elapsed
    return False, "ok", None  # keep injecting next tick


def _handle_possess(step):
    pc = _player_controller()
    if not pc:
        return True, "error", "no player controller to possess from"

    target = None
    world = _world()
    if step.get("actorTag"):
        tag = unreal.Name(step["actorTag"])
        for a in unreal.GameplayStatics.get_all_actors_with_tag(world, tag):
            target = a
            break
    elif step.get("actorClass"):
        cls_path = step["actorClass"]
        cls = unreal.load_class(None, cls_path)
        if cls:
            for a in unreal.GameplayStatics.get_all_actors_of_class(world, cls):
                target = a
                break

    if not target:
        return True, "error", "no matching actor for possess"

    try:
        pc.possess(target)
        return True, "ok", "possessed %s" % target.get_name()
    except Exception as e:
        return True, "error", "possess raised: %s" % e


def _diag_pawn_state(tag):
    """Best-effort snapshot of the player pawn's held item and nearby
    pickups, logged under [ClaudeScenario]. Lets a playRecording test
    confirm whether a gameplay outcome (e.g. grabbing an item) actually
    followed through, independent of game-side logging. Never raises."""
    try:
        pawn = _player_pawn()
        if not pawn:
            _log("pawnState[%s]: no pawn yet" % tag)
            return
        loc = pawn.get_actor_location()
        _log("pawnState[%s]: pawn=%s at (%.0f,%.0f,%.0f)" % (
            tag, pawn.get_name(), loc.x, loc.y, loc.z))
        # Held/equipped item — property names vary across the BP→C++
        # migration, so probe several and report whichever resolves.
        for prop in ("CurrentEquippedItem", "GrabbedItem", "HeldItem", "EquippedItem"):
            try:
                v = pawn.get_editor_property(prop)
            except Exception:
                continue
            _log("pawnState[%s]: %s -> %s" % (
                tag, prop, v.get_name() if v else "None"))
        # Nearby AInventoryItem actors: distance + attach parent. A grabbed
        # item attaches to the bear, so its attach-parent flips to the pawn
        # and its distance collapses to a hand offset — a game-agnostic
        # "did the grab land" signal.
        try:
            w = _world()
            cls = unreal.load_class(None, "/Script/BearGame.InventoryItem")
            if cls and w:
                rows = []
                for a in unreal.GameplayStatics.get_all_actors_of_class(w, cls):
                    al = a.get_actor_location()
                    d = ((al.x - loc.x) ** 2 + (al.y - loc.y) ** 2 + (al.z - loc.z) ** 2) ** 0.5
                    try:
                        par = a.get_attach_parent_actor()
                        par = par.get_name() if par else "-"
                    except Exception:
                        par = "?"
                    rows.append((d, a.get_name(), par))
                rows.sort()
                for d, name, par in rows[:4]:
                    _log("pawnState[%s]: item %s dist=%.0fcm attachedTo=%s" % (
                        tag, name, d, par))
        except Exception as e:
            _log("pawnState[%s]: item scan failed: %s" % (tag, e))
    except Exception as e:
        _log("pawnState[%s]: raised %s" % (tag, e))


def _handle_play_recording(step):
    """Replay a recorded session via Slate-level injection.

    The hard work happens in the editor-side `UClaudeInputRecorder`
    subsystem — we just kick off `Rec.Play <name>` via console and
    poll the recorder's `is_playing_back` state until it finishes.

    Before kicking off Rec.Play we bind any required InputMappingContexts
    onto the local player's EnhancedInputLocalPlayerSubsystem. A headless
    -game boot can skip the in-game flow (UI screen, level-start sequence)
    that normally wires AddMappingContext on the player, leaving the
    replayed key/mouse events with nothing to map to. Source priority:
        (a) step.mappingContexts (user-supplied, authoritative)
        (b) recording metadata (if the recording's JSON has the field)
        (c) pawn class default subobject (default_mapping_context etc.)
    Failures are logged and we proceed — the game's own BeginPlay may
    handle the binding regardless.

    Per-step state (state["sub"]):
        binds_done          bool — IMC bind phase ran (success or no-op)
        bind_wait_started   game-time when we started waiting for a pawn
        kicked_off          bool — have we called Rec.Play yet?
        pre_pos             pawn position snapshot before replay
        last_status_log     time of last Rec.Status-style log
    """
    sub = state["sub"]
    path = step.get("name", "")

    # Snapshot pawn pos once before kicking off so we can report motion.
    if "pre_pos" not in sub:
        pawn = _player_pawn()
        if pawn:
            p = pawn.get_actor_location()
            sub["pre_pos"] = (p.x, p.y, p.z)
        else:
            sub["pre_pos"] = None

    # One-shot IMC bind phase. We need a pawn (and therefore a local
    # player) to resolve the EnhancedInputLocalPlayerSubsystem — wait up
    # to 10s game time for it, then proceed bare. The wait is cheap; if
    # a pawn never appears the bind silently no-ops via the helper.
    if not sub.get("binds_done"):
        pawn = _player_pawn()
        if pawn is None:
            if "bind_wait_started" not in sub:
                sub["bind_wait_started"] = _game_seconds()
            if _game_seconds() - sub["bind_wait_started"] < 10.0:
                return False, "ok", None
            _log("IMC bind: pawn never appeared after 10s; proceeding without explicit bind")
            sub["bound_count"] = 0
            sub["binds_done"] = True
        else:
            # Source priority (a) → (b) → (c).
            imc_names = list(step.get("mappingContexts") or [])
            source = "step.mappingContexts" if imc_names else None
            if not imc_names:
                # Recording JSON metadata.
                try:
                    import json as _json
                    with open(path, "r") as f:
                        rec = _json.load(f)
                    for k in ("mappingContexts", "inputMappingContexts"):
                        v = rec.get(k)
                        if v:
                            imc_names = list(v)
                            source = "recording.%s" % k
                            break
                except Exception:
                    pass
            if not imc_names:
                discovered = _discover_pawn_default_imcs(pawn)
                if discovered:
                    imc_names = discovered
                    source = "pawn defaults"
            if imc_names:
                _log("IMC bind: %d context(s) from %s" % (len(imc_names), source))
                results = _bind_input_mapping_contexts(imc_names)
                sub["bound_count"] = sum(1 for _, ok, _ in results if ok)
            else:
                _log("IMC bind: 0 contexts found (no step.mappingContexts, no recording metadata, no pawn defaults)")
                sub["bound_count"] = 0
            sub["binds_done"] = True

    if not sub.get("kicked_off"):
        # Sanity: file exists?
        try:
            import os
            if not os.path.exists(path):
                return True, "error", "recording not found: %s" % path
        except Exception:
            pass
        # Suppress the OS cursor for agent-driven playback so the user's
        # physical mouse doesn't get yanked around mid-scenario. The
        # recorder dylib still routes Slate events to the right screen-
        # space position for hit-testing — only the SetCursorPos call is
        # gated by this cvar, so playback fidelity is unaffected.
        try:
            unreal.SystemLibrary.execute_console_command(_world(), "Rec.SuppressCursor 1")
        except Exception as e:
            _log("playRecording: Rec.SuppressCursor 1 raised: %s (continuing)" % e)
        # seekPawn: teleport the pawn to the recording's first pawn-location
        # sample before replay starts. The recorded inputs (walk to a spot,
        # press Interact) are authored relative to the capture-time pawn
        # position; if the map's PlayerStart drops the pawn somewhere else,
        # position-dependent outcomes (grabbing a world item, casting at a
        # lake) play out against the wrong geometry and silently miss. When
        # the spawn already matches the recording (PlayerStart == capture
        # spot) this is a ~0cm no-op. Best-effort; never aborts the replay.
        if step.get("seekPawn", True):
            try:
                import json as _seek_json
                with open(path, "r") as _sf:
                    _rec = _seek_json.load(_sf)
                _start_loc = None
                for _ev in _rec.get("events", []):
                    _pl = _ev.get("pawnLoc")
                    if _pl and len(_pl) == 3:
                        _start_loc = _pl
                        break
                _pawn = _player_pawn()
                if _start_loc and _pawn:
                    _dest = unreal.Vector(float(_start_loc[0]), float(_start_loc[1]), float(_start_loc[2]))
                    _cur = _pawn.get_actor_location()
                    _pawn.set_actor_location(_dest, False, True)
                    _log("seekPawn: pawn (%.0f,%.0f,%.0f) -> recording start (%.0f,%.0f,%.0f)" % (
                        _cur.x, _cur.y, _cur.z, _dest.x, _dest.y, _dest.z))
                elif not _start_loc:
                    _log("seekPawn: recording has no pawnLoc sample (skipping teleport)")
                else:
                    _log("seekPawn: no pawn yet to teleport (skipping)")
            except Exception as e:
                _log("seekPawn: raised %s (continuing without seek)" % e)
        # Kick off via console command — same path the user tested
        # interactively. Pass just the base name (recorder resolves to
        # standard dir) OR the full absolute path (recorder accepts both).
        _diag_pawn_state("preGrab")
        try:
            unreal.SystemLibrary.execute_console_command(_world(), "Rec.Play %s" % path)
            sub["kicked_off"] = True
            sub["last_status_log"] = _game_seconds()
            _log("playRecording: kicked off Rec.Play %s (cursor suppressed)" % path)
        except Exception as e:
            return True, "error", "Rec.Play raised: %s" % e
        return False, "ok", None  # keep ticking while playback runs

    # Poll the recorder subsystem to see when playback finishes.
    try:
        w = _world()
        gi = w.get_game_instance() if w else None
        recorder = gi.get_subsystem(unreal.ClaudeInputRecorder) if gi else None
    except Exception:
        recorder = None

    if recorder is None:
        # Can't poll directly — fall back to a fixed wait based on the
        # recording's duration (extract from JSON once).
        if "fallback_duration" not in sub:
            try:
                import json as _json
                with open(path, "r") as f:
                    rec = _json.load(f)
                sub["fallback_duration"] = float(rec.get("durationSeconds", 30.0))
            except Exception:
                sub["fallback_duration"] = 30.0
        elapsed = _game_seconds() - sub["started_at_game_sec"]
        if elapsed < sub["fallback_duration"] + 1.0:
            return False, "ok", None
    else:
        if recorder.is_playing_back():
            # Heartbeat the user every ~5s with progress.
            if _game_seconds() - sub["last_status_log"] >= 5.0:
                sub["last_status_log"] = _game_seconds()
                _log("playRecording: still going — fired %d/%d" % (
                    recorder.get_playback_events_fired(),
                    recorder.get_playback_event_count(),
                ))
            return False, "ok", None

    # Done. Compute motion delta for the trace.
    motion = ""
    pawn = _player_pawn()
    if pawn and sub.get("pre_pos"):
        p = pawn.get_actor_location()
        pre = sub["pre_pos"]
        dx, dy, dz = p.x - pre[0], p.y - pre[1], p.z - pre[2]
        dist = (dx * dx + dy * dy + dz * dz) ** 0.5
        motion = " | bear moved %.1f cm" % dist
    _diag_pawn_state("postPlayback")
    bound = sub.get("bound_count")
    binds = " | bound %d IMC(s)" % bound if bound is not None else ""
    return True, "ok", "Rec.Play complete%s%s" % (motion, binds)


def _resolve_target(spec):
    """Resolve a step 'target' string to an actor.

    'player'      -> the player pawn
    'controller'  -> the player controller
    'tag:Foo'     -> first actor tagged Foo
    '/Game/...'   -> first actor of that class (LoadClass'd on demand)
    """
    if not spec:
        return None, "empty target"
    if spec == "player":
        p = _player_pawn()
        return p, None if p else "no player pawn"
    if spec == "controller":
        pc = _player_controller()
        return pc, None if pc else "no player controller"
    world = _world()
    if not world:
        return None, "no world"
    if spec.startswith("tag:"):
        for a in unreal.GameplayStatics.get_all_actors_with_tag(
                world, unreal.Name(spec[4:])):
            return a, None
        return None, "no actor with tag %r" % spec[4:]
    if spec.startswith("name:"):
        wanted = spec[5:]
        for a in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor):
            if a.get_name() == wanted:
                return a, None
        return None, "no actor named %r" % wanted
    cls = unreal.load_class(None, spec)
    if not cls:
        return None, "could not load class %r" % spec
    a = unreal.GameplayStatics.get_actor_of_class(world, cls)
    return (a, None) if a else (None, "no actor of class %r in world" % spec)


def _handle_call_event(step):
    target, err = _resolve_target(step.get("target", ""))
    if err:
        return True, "error", err
    args = tuple(step.get("args") or [])
    name = step.get("event", "")
    try:
        result = target.call_method(name, args)
    except Exception as e:
        return True, "error", "call_method(%s) raised: %s" % (name, e)
    detail = "%s.%s(%s)" % (target.get_name(), name,
                            ", ".join(repr(a) for a in args))
    if result is not None:
        detail += " -> %s" % (result,)
    return True, "ok", detail


def _handle_spawn_actor(step):
    world = _world()
    if not world:
        return True, "error", "no world"
    loc = step.get("location")
    if loc:
        base = unreal.Vector(loc[0], loc[1], loc[2])
    else:
        pawn = _player_pawn()
        if not pawn:
            return True, "error", "no player pawn for relative spawn"
        base = pawn.get_actor_location()
    off = step.get("offset") or [0, 0, 0]
    base = unreal.Vector(base.x + off[0], base.y + off[1], base.z + off[2])
    try:
        # GameplayStatics' spawn entry points aren't exposed to Python in
        # -game mode; the bridge runtime library provides one.
        actor = unreal.ClaudeRuntimeLibrary.spawn_actor_by_path(
            step.get("actorClass", ""), base, unreal.Rotator(0, 0, 0))
        if actor is None:
            return True, "error", "SpawnActorByPath returned None (bad class path or no world)"
    except Exception as e:
        return True, "error", "spawn raised: %s" % e
    return True, "ok", "spawned %s at (%.0f, %.0f, %.0f)" % (
        actor.get_name(), base.x, base.y, base.z)


def _handle_teleport_player(step):
    pawn = _player_pawn()
    if not pawn:
        return True, "error", "no player pawn"
    loc = step.get("location")
    if loc:
        base = unreal.Vector(loc[0], loc[1], loc[2])
    elif step.get("toActorClass"):
        target, err = _resolve_target(step["toActorClass"])
        if err:
            return True, "error", err
        base = target.get_actor_location()
    else:
        return True, "error", "need location or toActorClass"
    off = step.get("offset") or [0, 0, 0]
    base = unreal.Vector(base.x + off[0], base.y + off[1], base.z + off[2])
    try:
        pawn.set_actor_location(base, False, True)
    except Exception as e:
        return True, "error", "set_actor_location raised: %s" % e
    return True, "ok", "player at (%.0f, %.0f, %.0f)" % (base.x, base.y, base.z)


def _handle_query_property(step):
    target, err = _resolve_target(step.get("target", ""))
    if step.get("expectMissing"):
        # Inverted assertion: PASS when the target does NOT resolve
        # (e.g. "this actor should have been destroyed").
        if err:
            return True, "ok", "confirmed missing: %s" % err
        return True, "mismatch", "%s still exists (expected missing)" % target.get_name()
    if err:
        return True, "error", err
    if step.get("component"):
        comp = _find_component(target, step["component"])
        if not comp:
            return True, "error", "no component %r on %s" % (step["component"], target.get_name())
        target = comp
    prop = step.get("property", "")
    if "." in prop:
        lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
        if lib is None or not hasattr(lib, "get_field_by_path"):
            return True, "error", "dot-path query needs ClaudeRuntimeLibrary.GetFieldByPath (rebuild bridge)"
        sval = str(lib.get_field_by_path(target, prop))
        if sval == "":
            return True, "error", "path %r did not resolve on %s" % (prop, target.get_name())
    else:
        try:
            value = target.get_editor_property(prop)
        except Exception as e:
            return True, "error", "get_editor_property(%s) raised: %s" % (prop, e)
        sval = str(value)
    detail = "%s.%s = %s" % (target.get_name(), prop, sval)
    expect = step.get("expect")
    if expect is not None and expect not in sval:
        return True, "mismatch", detail + " (expected to contain %r)" % expect
    return True, "ok", detail



def _find_component(actor, comp_name):
    """Find a SceneComponent on `actor` by exact name."""
    try:
        for c in actor.get_components_by_class(unreal.SceneComponent):
            if c.get_name() == comp_name:
                return c
    except Exception:
        pass
    return None


def _endpoint_screen_pos(spec):
    """Resolve a {target, component?} endpoint to (screen_pos, err)."""
    target, err = _resolve_target(spec.get("target", ""))
    if err:
        return None, err
    if spec.get("component"):
        comp = _find_component(target, spec["component"])
        if not comp:
            return None, "no component %r on %s" % (spec["component"], target.get_name())
        world = comp.get_world_location()
    else:
        world = target.get_actor_location()
    pc = _player_controller()
    if not pc:
        return None, "no player controller"
    try:
        ret = pc.project_world_location_to_screen(world, False)
    except Exception as e:
        return None, "project_world_location_to_screen raised: %s" % e
    # Returns (bool, Vector2D) or Vector2D depending on binding version.
    if isinstance(ret, tuple):
        ok, screen = ret[0], ret[1]
        if not ok:
            return None, "projection failed (behind camera?)"
    else:
        screen = ret
    return (float(screen.x), float(screen.y)), None


def _handle_drag_mouse(step):
    """Synthetic Slate mouse drag from one actor/component to another.

    Phases per tick: resolve+hover -> press -> lerp move -> release -> settle.
    Endpoints are re-projected once at start (the menu is paused; nothing moves).
    """
    sub = state["sub"]
    lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
    if lib is None or not hasattr(lib, "inject_mouse_move"):
        return True, "error", "ClaudeRuntimeLibrary.inject_mouse_move missing (rebuild bridge)"

    if "drag" not in sub:
        start, err = _endpoint_screen_pos(step.get("from", {}))
        if err:
            return True, "error", "from: " + err
        end, err = _endpoint_screen_pos(step.get("to", {}))
        if err:
            return True, "error", "to: " + err
        ticks = max(int(float(step.get("durationSec", 0.6)) * 60), 10)
        sub["drag"] = {"start": start, "end": end, "ticks": ticks, "i": 0,
                       "phase": "hover", "hover_ticks": 0, "settle": 0}
        _log("dragMouse: %s -> %s over %d ticks" % (start, end, ticks))

    d = sub["drag"]
    sx, sy = d["start"]
    ex, ey = d["end"]

    if d["phase"] == "hover":
        lib.inject_mouse_move(sx, sy)
        d["hover_ticks"] += 1
        if d["hover_ticks"] >= 3:
            d["phase"] = "press"
        return False, "ok", None
    if d["phase"] == "press":
        lib.inject_mouse_button(sx, sy, True)
        d["phase"] = "move"
        return False, "ok", None
    if d["phase"] == "move":
        d["i"] += 1
        t = min(d["i"] / float(d["ticks"]), 1.0)
        x = sx + (ex - sx) * t
        y = sy + (ey - sy) * t
        lib.inject_mouse_move(x, y)
        if t >= 1.0:
            d["phase"] = "release"
        return False, "ok", None
    if d["phase"] == "release":
        lib.inject_mouse_button(ex, ey, False)
        d["phase"] = "settle"
        return False, "ok", None
    d["settle"] += 1
    if d["settle"] >= 10:
        return True, "ok", "dragged (%.0f,%.0f) -> (%.0f,%.0f)" % (sx, sy, ex, ey)
    return False, "ok", None


def _handle_mouse_press(step):
    """Hover an actor/component for 3 ticks, then press LMB there and KEEP IT
    HELD. Pairs with mouseMoveTo / mouseRelease so a scenario can observe
    (screenshot, pyEval) MID-DRAG — dragMouse is atomic and can't."""
    sub = state["sub"]
    lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
    if lib is None or not hasattr(lib, "inject_mouse_move"):
        return True, "error", "ClaudeRuntimeLibrary.inject_mouse_move missing (rebuild bridge)"
    if "pos" not in sub:
        pos, err = _endpoint_screen_pos({"target": step.get("target", ""),
                                         "component": step.get("component")})
        if err:
            return True, "error", err
        sub["pos"] = pos
        sub["ticks"] = 0
    x, y = sub["pos"]
    sub["ticks"] += 1
    if sub["ticks"] <= 3:
        lib.inject_mouse_move(x, y)
        return False, "ok", None
    lib.inject_mouse_button(x, y, True)
    state["mouse_pos"] = (x, y)
    return True, "ok", "pressed at (%.0f,%.0f)" % (x, y)


def _handle_mouse_move_to(step):
    """Lerp the held cursor from its current position to an actor/component
    over durationSec. Button state is untouched (use after mousePress)."""
    sub = state["sub"]
    lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
    if lib is None or not hasattr(lib, "inject_mouse_move"):
        return True, "error", "ClaudeRuntimeLibrary.inject_mouse_move missing (rebuild bridge)"
    if "move" not in sub:
        start = state.get("mouse_pos")
        if start is None:
            return True, "error", "no prior mousePress/dragMouse set a cursor position"
        end, err = _endpoint_screen_pos({"target": step.get("target", ""),
                                         "component": step.get("component")})
        if err:
            return True, "error", err
        ticks = max(int(float(step.get("durationSec", 0.6)) * 60), 10)
        sub["move"] = {"start": start, "end": end, "ticks": ticks, "i": 0}
    m = sub["move"]
    m["i"] += 1
    t = min(m["i"] / float(m["ticks"]), 1.0)
    x = m["start"][0] + (m["end"][0] - m["start"][0]) * t
    y = m["start"][1] + (m["end"][1] - m["start"][1]) * t
    lib.inject_mouse_move(x, y)
    state["mouse_pos"] = (x, y)
    if t >= 1.0:
        return True, "ok", "cursor at (%.0f,%.0f)" % (x, y)
    return False, "ok", None


def _handle_mouse_release(step):
    """Release LMB at the current cursor position, then settle 10 ticks."""
    sub = state["sub"]
    lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
    if lib is None or not hasattr(lib, "inject_mouse_move"):
        return True, "error", "ClaudeRuntimeLibrary.inject_mouse_move missing (rebuild bridge)"
    pos = state.get("mouse_pos")
    if pos is None:
        return True, "error", "no cursor position to release at"
    if "released" not in sub:
        lib.inject_mouse_button(pos[0], pos[1], False)
        sub["released"] = True
        sub["settle"] = 0
        return False, "ok", None
    sub["settle"] += 1
    if sub["settle"] >= 10:
        return True, "ok", "released at (%.0f,%.0f)" % (pos[0], pos[1])
    return False, "ok", None


def _handle_click_mouse(step):
    """Synthetic click on an actor/component: hover 3 ticks, press, hold 2, release, settle."""
    sub = state["sub"]
    lib = getattr(unreal, "ClaudeRuntimeLibrary", None)
    if lib is None or not hasattr(lib, "inject_mouse_move"):
        return True, "error", "ClaudeRuntimeLibrary.inject_mouse_move missing (rebuild bridge)"
    if "click" not in sub:
        pos, err = _endpoint_screen_pos({"target": step.get("target", ""),
                                         "component": step.get("component")})
        if err:
            return True, "error", err
        sub["click"] = {"pos": pos, "phase": "hover", "ticks": 0}
    c = sub["click"]
    x, y = c["pos"]
    c["ticks"] += 1
    if c["phase"] == "hover":
        lib.inject_mouse_move(x, y)
        if c["ticks"] >= 3:
            c["phase"], c["ticks"] = "down", 0
        return False, "ok", None
    if c["phase"] == "down":
        lib.inject_mouse_button(x, y, True)
        c["phase"], c["ticks"] = "held", 0
        return False, "ok", None
    if c["phase"] == "held":
        if c["ticks"] >= 2:
            lib.inject_mouse_button(x, y, False)
            c["phase"], c["ticks"] = "settle", 0
        return False, "ok", None
    if c["ticks"] >= 10:
        return True, "ok", "clicked (%.0f,%.0f)" % (x, y)
    return False, "ok", None


def _handle_py_eval(step):
    """Evaluate a Python expression with `unreal` in scope and compare its
    str() against an optional `expect` substring. Exists so scenarios can
    unit-test pure BlueprintFunctionLibrary helpers (e.g. grid math) without
    routing through an actor."""
    expr = step.get("expr", "")
    try:
        value = eval(expr, {"unreal": unreal})
    except Exception as e:
        return True, "error", "pyEval raised: %s" % e
    sval = str(value)
    detail = "%s = %s" % (expr[:80], sval[:2000])
    expect = step.get("expect")
    if expect is not None and expect not in sval:
        return True, "mismatch", detail + " (expected to contain %r)" % expect
    return True, "ok", detail


def _handle_quit(step):
    # Don't terminate or set shutting_down here — that would skip the
    # natural completion path in _tick which writes the result JSON.
    # Returning done=True advances step_idx; on the next tick, the
    # "all steps complete" branch fires _quit_now which writes results
    # AND attempts to quit. If quit_game can't terminate (no world
    # context), the Node side's poll-and-kill backstop SIGTERMs us
    # once it sees the result JSON land.
    return True, "ok", None


HANDLERS = {
    "exec": _handle_exec,
    "wait": _handle_wait,
    "waitForLog": _handle_wait_for_log,
    "injectAction": _handle_inject,
    "possess": _handle_possess,
    "playRecording": _handle_play_recording,
    "callEvent": _handle_call_event,
    "spawnActor": _handle_spawn_actor,
    "teleportPlayer": _handle_teleport_player,
    "queryProperty": _handle_query_property,
    "dragMouse": _handle_drag_mouse,
    "clickMouse": _handle_click_mouse,
    "mousePress": _handle_mouse_press,
    "mouseMoveTo": _handle_mouse_move_to,
    "mouseRelease": _handle_mouse_release,
    "pyEval": _handle_py_eval,
    "quit": _handle_quit,
}


# --------------------------------------------------------------------------
# Tick driver
# --------------------------------------------------------------------------

def _record(step, outcome, detail):
    sub = state["sub"] or {}
    started = sub.get("started_at_game_sec", 0.0)
    now = _game_seconds()
    state["results"].append({
        "index": state["step_idx"],
        "type": step.get("type", "?"),
        "startedAtGameSec": started,
        "endedAtGameSec": now,
        "durationSec": now - started,
        "outcome": outcome,
        "detail": detail,
    })


def _write_results(early_exit=None):
    payload = {
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(state["started_wall_at"])),
        "steps": state["results"],
        "finalGameSec": _game_seconds(),
    }
    if early_exit:
        payload["earlyExit"] = early_exit
    if not RESULT_JSON:
        return
    try:
        with open(RESULT_JSON, "w") as f:
            json.dump(payload, f, indent=2)
        _log("wrote results to %s" % RESULT_JSON)
    except Exception as e:
        _err("failed to write results: %s" % e)


def _quit_now(reason):
    if state["shutting_down"]:
        return
    state["shutting_down"] = True
    _log("shutting down: %s" % reason)
    _write_results(early_exit=reason if reason != "complete" else None)
    # If we started PIE, end the session first so the editor returns to a
    # clean state before we quit it.
    if AUTOSTART_PIE and state["pie_triggered"]:
        _end_pie()
    try:
        unreal.SystemLibrary.quit_game(_world(), None, unreal.QuitPreference.QUIT, False)
    except Exception:
        unreal.SystemLibrary.execute_console_command(_world(), "quit")


def _tick(delta_seconds):
    if state["shutting_down"]:
        return
    try:
        state["tick_count"] += 1

        # Heartbeat every ~200 ticks so we can tell from the log whether
        # the tick callback is actually firing.
        if state["tick_count"] - state["last_heartbeat_tick"] >= 200:
            state["last_heartbeat_tick"] = state["tick_count"]
            w = _world()
            pc = _player_controller()
            _log("heartbeat: tick=%d world=%s pc=%s wall=%.1fs" % (
                state["tick_count"],
                "yes" if w else "no",
                "yes" if pc else "no",
                time.time() - state["started_wall_at"],
            ))

        # We no longer block on world being ready — we'll proceed and let
        # individual step handlers decide if they need a world (and fail
        # gracefully if not). Record world-ready transition for the trace.
        if state["world_ready_at"] is None and _world() is not None:
            state["world_ready_at"] = _game_seconds()
            _log("world ready at game sec=%.2f, %d step(s) queued" % (
                state["world_ready_at"], len(STEPS)))

        # AUTOSTART_PIE pre-phase: editor binary was launched without -game.
        # We wait for an editor world, trigger PIE programmatically, then
        # wait for the PIE world to come up. Only then do we let steps run.
        # NOTE: run-scenario.ts no longer sets CLAUDE_SCENARIO_AUTOSTART_PIE
        # for playRecording (we use `-game -RenderOffscreen` instead). This
        # block is preserved for future tools that may want a PIE pre-phase.
        if AUTOSTART_PIE:
            if not state["pie_triggered"]:
                if _has_editor_world():
                    if _try_start_pie():
                        state["pie_triggered"] = True
                        _log("PIE triggered at wall=%.1fs, waiting for PIE world..." %
                             (time.time() - state["started_wall_at"]))
                return  # not ready to run steps yet
            if state["pie_active_at"] is None:
                if _has_pie_world():
                    # Invalidate the cached world (which may still point at
                    # the editor world) so subsequent calls pick PIE up.
                    _world_cache["world"] = None
                    state["pie_active_at"] = time.time() - state["started_wall_at"]
                    _log("PIE active at wall=%.1fs — running steps in PIE world" %
                         state["pie_active_at"])
                else:
                    return  # waiting for PIE

        if state["step_idx"] >= len(STEPS):
            _quit_now("complete")
            return

        step = STEPS[state["step_idx"]]
        if state["sub"] is None:
            state["sub"] = {
                "started_at_game_sec": _game_seconds(),
                "started_at_wall": time.time(),
            }
            _log("step %d BEGIN: %s" % (state["step_idx"], step.get("type")))

        handler = HANDLERS.get(step.get("type"))
        if handler is None:
            _record(step, "error", "unknown step type")
            state["step_idx"] += 1
            state["sub"] = None
            return

        done, outcome, detail = handler(step)
        if done:
            _record(step, outcome, detail)
            _log("step %d END (%s)%s" % (
                state["step_idx"], outcome,
                " - " + detail if detail else ""))
            state["step_idx"] += 1
            state["sub"] = None
    except Exception as e:
        _err("scenario tick raised: %s\n%s" % (e, traceback.format_exc()))
        _quit_now("tick exception: %s" % e)


# --------------------------------------------------------------------------
# Arm
# --------------------------------------------------------------------------

def _arm():
    if not STEPS:
        _err("no steps loaded — exiting immediately")
        _quit_now("no steps")
        return
    _log("arming scenario runner with %d step(s)" % len(STEPS))
    state["tick_handle"] = unreal.register_slate_post_tick_callback(_tick)


_arm()
