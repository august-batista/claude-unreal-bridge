import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { UEProject } from "../types/ue-project.js";

export interface ProjectOverview {
  projectName: string;
  engineVersion: string;
  contentDir: string;
  hasSource: boolean;
  modules: string[];
  enabledPlugins: string[];
  assetCounts: Record<string, number>;
  directoryTree: string;
}

/**
 * Scan a UE project directory and produce an overview.
 */
export function scanProjectStructure(project: UEProject): ProjectOverview {
  const assetCounts: Record<string, number> = {};

  // Count assets by extension in Content/
  if (existsSync(project.contentPath)) {
    countAssetsRecursive(project.contentPath, assetCounts);
  }

  // Build a directory tree (limited depth)
  const directoryTree = buildDirectoryTree(project.projectPath, 3);

  return {
    projectName: project.projectName,
    engineVersion: project.engineVersion,
    contentDir: project.contentPath,
    hasSource: !!project.sourcePath,
    modules: project.modules,
    enabledPlugins: project.plugins.filter((p) => p.enabled).map((p) => p.name),
    assetCounts,
    directoryTree,
  };
}

function countAssetsRecursive(
  dir: string,
  counts: Record<string, number>,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        countAssetsRecursive(fullPath, counts);
      } else {
        const ext = extname(entry).toLowerCase();
        if (ext === ".uasset" || ext === ".umap") {
          counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    } catch {
      // Skip inaccessible files
    }
  }
}

function buildDirectoryTree(
  rootDir: string,
  maxDepth: number,
  currentDepth: number = 0,
  prefix: string = "",
): string {
  if (currentDepth >= maxDepth) return "";

  let entries: string[];
  try {
    entries = readdirSync(rootDir).filter(
      (e) =>
        !e.startsWith(".") &&
        e !== "node_modules" &&
        e !== "Intermediate" &&
        e !== "Saved" &&
        e !== "DerivedDataCache" &&
        e !== "Binaries",
    );
  } catch {
    return "";
  }

  const lines: string[] = [];

  // Sort: directories first, then files
  const sorted = entries
    .map((e) => {
      const fullPath = join(rootDir, e);
      try {
        return { name: e, isDir: statSync(fullPath).isDirectory() };
      } catch {
        return { name: e, isDir: false };
      }
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const isLast = i === sorted.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const nextPrefix = isLast ? "    " : "│   ";

    lines.push(`${prefix}${connector}${entry.name}${entry.isDir ? "/" : ""}`);

    if (entry.isDir) {
      const subtree = buildDirectoryTree(
        join(rootDir, entry.name),
        maxDepth,
        currentDepth + 1,
        prefix + nextPrefix,
      );
      if (subtree) lines.push(subtree);
    }
  }

  return lines.join("\n");
}

/**
 * Format a project overview as markdown.
 */
export function formatProjectOverview(overview: ProjectOverview): string {
  const lines: string[] = [];

  lines.push(`# Unreal Engine Project: ${overview.projectName}`);
  lines.push(`**Engine Version:** ${overview.engineVersion}`);
  lines.push(`**Has C++ Source:** ${overview.hasSource ? "Yes" : "No"}`);

  if (overview.modules.length > 0) {
    lines.push(`**Modules:** ${overview.modules.join(", ")}`);
  }

  if (overview.enabledPlugins.length > 0) {
    lines.push("", "## Enabled Plugins", "");
    for (const p of overview.enabledPlugins) {
      lines.push(`- ${p}`);
    }
  }

  lines.push("", "## Asset Counts", "");
  for (const [ext, count] of Object.entries(overview.assetCounts)) {
    lines.push(`- ${ext}: ${count}`);
  }

  lines.push("", "## Directory Structure", "", "```");
  lines.push(overview.directoryTree);
  lines.push("```");

  return lines.join("\n");
}
