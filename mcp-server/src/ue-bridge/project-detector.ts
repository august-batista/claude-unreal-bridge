import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { UEProject, UProjectFile } from "../types/ue-project.js";
import { findBestInstallation } from "./engine-locator.js";

const projectCache = new Map<string, UEProject>();

export function detectProject(projectPath: string): UEProject {
  const cached = projectCache.get(projectPath);
  if (cached) return cached;

  // Find .uproject file
  const uprojectFile = findUProjectFile(projectPath);
  if (!uprojectFile) {
    throw new Error(
      `No .uproject file found in ${projectPath}. Is this an Unreal Engine project?`,
    );
  }

  // Parse the .uproject file
  const uprojectContent = readFileSync(uprojectFile, "utf-8");
  let uproject: UProjectFile;
  try {
    uproject = JSON.parse(uprojectContent);
  } catch {
    throw new Error(`Failed to parse ${uprojectFile}: invalid JSON`);
  }

  const projectDir = dirname(uprojectFile);
  const projectName = basename(uprojectFile, ".uproject");
  const engineVersion = uproject.EngineAssociation || "unknown";

  // Find the matching UE installation
  const installation = findBestInstallation(engineVersion);
  if (!installation) {
    throw new Error(
      `No Unreal Engine installation found for version ${engineVersion}. ` +
        `Set UE_ROOT environment variable to your UE installation path.`,
    );
  }

  const contentPath = join(projectDir, "Content");
  const sourcePath = join(projectDir, "Source");

  const project: UEProject = {
    projectPath: projectDir,
    projectName,
    uprojectFile,
    engineVersion,
    enginePath: installation.path,
    contentPath,
    sourcePath: existsSync(sourcePath) ? sourcePath : undefined,
    modules: (uproject.Modules || []).map((m) => m.Name),
    plugins: (uproject.Plugins || []).map((p) => ({
      name: p.Name,
      enabled: p.Enabled,
    })),
  };

  projectCache.set(projectPath, project);
  return project;
}

function findUProjectFile(searchPath: string): string | null {
  // Check if the path itself is a .uproject file
  if (searchPath.endsWith(".uproject") && existsSync(searchPath)) {
    return searchPath;
  }

  // Search the directory for .uproject files
  if (!existsSync(searchPath)) {
    throw new Error(`Path does not exist: ${searchPath}`);
  }

  const entries = readdirSync(searchPath);
  const uprojectFiles = entries.filter((e) => e.endsWith(".uproject"));

  if (uprojectFiles.length === 0) return null;
  if (uprojectFiles.length > 1) {
    console.error(
      `Multiple .uproject files found, using ${uprojectFiles[0]}`,
    );
  }

  return join(searchPath, uprojectFiles[0]);
}

/**
 * Convert a file path to a UE asset path.
 * e.g., /path/to/Project/Content/Blueprints/BP_Player.uasset -> /Game/Blueprints/BP_Player
 */
export function filePathToAssetPath(
  filePath: string,
  project: UEProject,
): string {
  const contentDir = project.contentPath;
  let rel = filePath;

  if (rel.startsWith(contentDir)) {
    rel = rel.substring(contentDir.length);
  }

  // Remove leading slash and .uasset extension
  rel = rel.replace(/^\//, "").replace(/\.uasset$/, "");

  return `/Game/${rel}`;
}

/**
 * Convert a UE asset path to a file path.
 * e.g., /Game/Blueprints/BP_Player -> /path/to/Project/Content/Blueprints/BP_Player.uasset
 */
export function assetPathToFilePath(
  assetPath: string,
  project: UEProject,
): string {
  // /Game/... maps to Content/...
  let rel = assetPath;
  if (rel.startsWith("/Game/")) {
    rel = rel.substring("/Game/".length);
  } else if (rel.startsWith("/game/")) {
    rel = rel.substring("/game/".length);
  }

  return join(project.contentPath, `${rel}.uasset`);
}

/**
 * Normalize user input to a valid asset path.
 * Accepts file paths, asset paths, or partial names.
 */
export function normalizeToAssetPath(
  input: string,
  project: UEProject,
): string {
  // Already an asset path
  if (input.startsWith("/Game/") || input.startsWith("/Script/")) {
    return input.replace(/\.uasset$/, "");
  }

  // It's a file path
  if (input.includes("/Content/") || input.endsWith(".uasset")) {
    return filePathToAssetPath(input, project);
  }

  // Assume it's a partial asset path, prepend /Game/
  return `/Game/${input.replace(/^\//, "").replace(/\.uasset$/, "")}`;
}

export function clearCache(): void {
  projectCache.clear();
}
