---
name: blueprint-reader
description: >
  Read and understand Unreal Engine blueprint code. Use when the user asks about
  what a blueprint does, how blueprint logic flows, what events or functions a
  blueprint contains, wants to navigate blueprint graphs, or asks about any
  .uasset blueprint file in an Unreal Engine project. Trigger phrases include
  "read blueprint", "what does this blueprint do", "blueprint logic",
  "event graph", "blueprint variables", "blueprint functions".
---

# Blueprint Reader

Read UE blueprint code using the claude-unreal MCP tools.

## How to read blueprints

1. Identify the UE project path (look for a .uproject file)
2. Use `list-blueprints` to discover available blueprints
3. Use `read-blueprint` with the asset path to read specific blueprints
4. Use `search-blueprints` to find blueprints containing specific logic

## Interpreting blueprint data

Blueprint graphs consist of nodes connected by pins:

- **Exec pins** (white) control execution flow — like code statements in sequence
- **Data pins** (colored) pass values between nodes — like function arguments/returns
- **Event nodes** are entry points: BeginPlay, Tick, custom events, input actions
- **Function call nodes** invoke functions on objects or libraries
- **Variable Get/Set nodes** read or write blueprint variables
- **Branch nodes** are if/else conditionals
- **For/ForEach/While** nodes are loops
- **Sequence nodes** execute multiple paths in order
- **Cast nodes** perform type casting
- **Macro nodes** are reusable sub-graphs

When explaining blueprint logic, translate the visual node graph into
equivalent pseudocode. Describe execution flow step by step, noting
what data flows between nodes and what conditions control branching.

## Common patterns

- **BeginPlay -> Setup**: Initialization logic when actor spawns
- **Tick -> Update**: Per-frame update logic
- **Event Dispatchers**: Blueprint-to-blueprint communication
- **Interface calls**: Polymorphic function calls across blueprint types
- **Timeline nodes**: Interpolation and animation over time
- **Delay/Timer nodes**: Deferred execution
