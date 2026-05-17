// Scripted scenario step schema.
//
// The bridge serialises a `ScenarioStep[]` to JSON, hands the path to a
// Python runner via env var, and the runner executes each step in order
// inside the running -game UE instance using a Slate post-tick callback.
//
// Each step is processed every tick until its handler returns "done".
// Game-time semantics throughout — waits scale with `slomo`, with engine
// pause, and across machines with different perf.

export type ScenarioStep =
  | ExecStep
  | WaitStep
  | WaitForLogStep
  | InjectActionStep
  | PossessStep
  | PlayRecordingStep
  | QuitStep;

/** Send a console command (KE * MyEvent, cheat, cvar, etc.). One-shot. */
export interface ExecStep {
  type: "exec";
  cmd: string;
}

/** Wait N seconds of game time. Scales with slomo / engine pause. */
export interface WaitStep {
  type: "wait";
  seconds: number;
}

/**
 * Wait until a log line matches the regex (or timeout).
 *
 * The runner tails `<Project>/Saved/Logs/<Project>.log` from where it left
 * off in previous waitForLog steps, so multiple sequential waitForLogs are
 * resumable rather than re-scanning history.
 *
 * On timeout the step advances; the trace records whether it matched or
 * timed out so the scenario doesn't silently stall.
 */
export interface WaitForLogStep {
  type: "waitForLog";
  pattern: string; // Python re-style regex, case-insensitive
  timeoutSec: number;
}

/**
 * Inject an Enhanced Input action via UEnhancedInputLocalPlayerSubsystem.
 * This fires the actual player input pipeline — same code path the player
 * exercises by pressing the button — not a bypass cheat.
 *
 *   action: asset path or short name of an UInputAction asset
 *           (e.g. "IA_UseItemPrimary" or "/Game/.../IA_UseItemPrimary")
 *   value:  input value, type-inferred by length
 *             number       → boolean / Axis1D (default 1.0)
 *             [x, y]       → Axis2D (movement, look)
 *             [x, y, z]    → Axis3D
 *   holdSec: if set, re-inject every tick for this many game-time seconds
 *            (held buttons, charge-up casts, etc.). Omit for a single-tick
 *            inject (discrete button press).
 */
export interface InjectActionStep {
  type: "injectAction";
  action: string;
  value?: number | [number, number] | [number, number, number];
  holdSec?: number;
}

/**
 * Force the local player controller to possess a specific actor. Useful
 * when the default game mode hasn't spawned the pawn you want to drive,
 * or when there are multiple candidate pawns.
 *
 * Provide one of: tag (finds the first actor with that tag) or
 * className (finds the first actor of that class; accepts /Game/ paths).
 */
export interface PossessStep {
  type: "possess";
  actorTag?: string;
  actorClass?: string;
}

/**
 * Replay a previously-recorded session. The recording captures real
 * Enhanced Input events (Started/Triggered/Completed) plus camera +
 * pawn-location samples at ~30Hz. Playback re-injects each event at
 * its original game-time offset via `InjectInputForAction`, optionally
 * snapping the pawn to its recorded location at start so the bear is
 * in the right place before the inputs fire.
 *
 *   `name`     — base name of the recording, e.g. "FishTest1". Resolves
 *                to <Project>/Saved/ClaudeRecordings/<name>.json. If the
 *                name ends in `.json` or contains a slash, treated as a
 *                full path.
 *   `seekPawn` — if true (default), teleport the player pawn to the
 *                recording's first pawn-location sample before replay
 *                starts. Avoids "bear is in the wrong place" replays.
 */
export interface PlayRecordingStep {
  type: "playRecording";
  name: string;
  seekPawn?: boolean;
}

/** Tell UE to quit cleanly. The runner sends this automatically when all
 *  steps complete, so it's usually only needed for mid-script aborts. */
export interface QuitStep {
  type: "quit";
}

// ---- Runner output ----

/**
 * Per-step trace entry the runner writes to its result JSON. The bridge
 * reads this back after the editor exits to assemble the response.
 */
export interface ScenarioStepResult {
  index: number;
  type: ScenarioStep["type"];
  startedAtGameSec: number;
  endedAtGameSec: number;
  durationSec: number;
  outcome: "ok" | "timedOut" | "error" | "matched" | "notMatched";
  detail?: string; // free-text: matched pattern, error message, etc.
}

export interface ScenarioRunResult {
  startedAt: string; // ISO timestamp
  steps: ScenarioStepResult[];
  finalGameSec: number;
  earlyExit?: string; // populated if the runner aborted early
}
