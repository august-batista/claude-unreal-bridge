---
name: context-generator
description: >
  Generate documentation and context files for Unreal Engine projects. Use when
  the user wants to create a project overview, blueprint inventory, class
  hierarchy documentation, or CLAUDE.md-style context for their UE project.
  Trigger phrases include "scan project", "generate context", "project overview",
  "blueprint inventory", "class hierarchy", "document this UE project".
---

# UE Context Generator

Generate comprehensive documentation for Unreal Engine projects.

## When to use

- User asks for a project overview or documentation
- User wants a context file for their UE project
- User needs to understand the overall project structure
- User wants a blueprint inventory or class hierarchy

## How to generate

1. Use `generate-context` with the project path
2. The tool scans the project and generates UNREAL_CONTEXT.md
3. Sections include: overview, blueprints, classes, hierarchy
4. The file is written to the project root by default

## What's included

- **Overview**: Project name, engine version, modules, plugins, asset counts, directory tree
- **Blueprints**: Full inventory of all blueprints grouped by directory
- **Hierarchy**: Class inheritance tree showing blueprint parent-child relationships
