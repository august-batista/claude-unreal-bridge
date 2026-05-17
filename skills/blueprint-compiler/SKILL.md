---
name: blueprint-compiler
description: >
  Compile and validate Unreal Engine blueprints (and the C++ they depend on).
  Use when the user wants to check for blueprint compilation errors, validate
  blueprint integrity, verify that changes compile correctly, or build the
  project. Trigger phrases include "compile blueprints", "build the project",
  "check for errors", "validate blueprints", "are there any compilation
  errors", "make sure this builds".
---

# Blueprint Compiler

Compile and validate UE projects via the headless editor toolchain.

## The two compile stages

Order matters. C++ compiles first; blueprints can only compile against a
buildable editor module.

1. **`build-cpp`** — invokes UnrealBuildTool to build the editor target.
   No-op for Blueprint-only projects (no `Source/` folder). Returns
   structured errors with `file:line:column`.
2. **`compile-blueprints`** — runs the `CompileAllBlueprints` commandlet.
   Parses errors anchored on `LogBlueprint` / `LogK2Compiler` /
   `LogCompileAllBlueprintsCommandlet` so unrelated startup warnings
   aren't misreported as compile failures.

The `/ue-build` slash command runs both in order. Use individual tools
when you only need one stage (rebuilding C++ after a header change but
not yet touching blueprints, etc.).

## Reading the results

- Trust the **summary totals** when present (`Total Successful Blueprints`
  / `Total Failed Blueprints` from the commandlet) — those are the
  authoritative counts.
- The per-error list is deduped and includes the source category; surface
  the asset path when the parser extracted one.
- For C++ failures, the `file:line:column` and (on MSVC) error code make
  the issue easy to locate.
- If something failed but the parser didn't pick it up, follow with
  `read-logs` to see the full output.

## Important notes

- Compilation requires UE to load the project headlessly — first runs are
  slow (~30-60s startup, plus actual work).
- Use `projectOnly: true` on `compile-blueprints` (default) to skip
  engine/plugin blueprints.
- Common BP errors: broken references, missing variables, type
  mismatches, circular dependencies. Common C++ errors: stale generated
  headers (clean Intermediate/), missing module dependencies in
  `<Module>.Build.cs`.
- After fixing issues, recompile to verify — both stages.
