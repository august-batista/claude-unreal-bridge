// Scripted scenario step schema.
//
// The bridge serialises a `ScenarioStep[]` to JSON, hands the path to a
// Python runner via env var, and the runner executes each step in order
// inside the running -game UE instance using a Slate post-tick callback.
//
// Each step is processed every tick until its handler returns "done".
// Game-time semantics throughout — waits scale with `slomo`, with engine
// pause, and across machines with different perf.
export {};
//# sourceMappingURL=scenario.js.map