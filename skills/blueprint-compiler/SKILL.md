---
name: blueprint-compiler
description: >
  Compile and validate Unreal Engine blueprints. Use when the user wants to
  check for blueprint compilation errors, validate blueprint integrity, verify
  that changes compile correctly, or run the project to check for issues.
  Trigger phrases include "compile blueprints", "check for errors",
  "validate blueprints", "are there any compilation errors", "build project".
---

# Blueprint Compiler

Compile and validate UE blueprints using the editor commandlet.

## How to compile

1. Use `compile-blueprints` with the project path
2. Review the output for errors and warnings
3. Report issues with specific blueprint paths and error messages

## Important notes

- Compilation requires the UE editor to load the project headlessly (takes 30-60s)
- The CompileAllBlueprints commandlet compiles every blueprint in the project
- Use `projectOnly: true` (default) to skip engine/plugin blueprints
- Common errors include: broken references, missing variables, type mismatches, circular dependencies
- After fixing issues, recompile to verify
