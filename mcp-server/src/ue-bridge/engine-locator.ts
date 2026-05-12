import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UEInstallation } from "../types/ue-project.js";

const EPIC_GAMES_DIRS: Record<string, string> = {
  darwin: "/Users/Shared/Epic Games",
  win32: "C:\\Program Files\\Epic Games",
  linux: "/opt/UnrealEngine",
};

const EDITOR_CMD_PATHS: Record<string, string> = {
  darwin: "Engine/Binaries/Mac/UnrealEditor-Cmd",
  win32: "Engine/Binaries/Win64/UnrealEditor-Cmd.exe",
  linux: "Engine/Binaries/Linux/UnrealEditor-Cmd",
};

const RUN_UAT_PATHS: Record<string, string> = {
  darwin: "Engine/Build/BatchFiles/RunUAT.sh",
  win32: "Engine/Build/BatchFiles/RunUAT.bat",
  linux: "Engine/Build/BatchFiles/RunUAT.sh",
};

let cachedInstallations: UEInstallation[] | null = null;

export function findUEInstallations(): UEInstallation[] {
  if (cachedInstallations) return cachedInstallations;

  const platform = process.platform;
  const installations: UEInstallation[] = [];

  // Check environment variable override first
  const ueRoot = process.env.UE_ROOT;
  if (ueRoot && existsSync(ueRoot)) {
    const install = tryParseInstallation(ueRoot, platform);
    if (install) installations.push(install);
  }

  // Scan default locations
  const epicDir = EPIC_GAMES_DIRS[platform];
  if (epicDir && existsSync(epicDir)) {
    const entries = readdirSync(epicDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("UE_")) {
        const enginePath = join(epicDir, entry.name);
        const install = tryParseInstallation(enginePath, platform);
        if (install) installations.push(install);
      }
    }
  }

  // Sort by version descending (newest first)
  installations.sort((a, b) => compareVersions(b.version, a.version));

  cachedInstallations = installations;
  return installations;
}

export function findBestInstallation(
  targetVersion?: string,
): UEInstallation | null {
  const installations = findUEInstallations();
  if (installations.length === 0) return null;

  if (targetVersion) {
    // Find exact or closest match
    const exact = installations.find((i) => i.version === targetVersion);
    if (exact) return exact;

    // Find major.minor match
    const majorMinor = targetVersion.split(".").slice(0, 2).join(".");
    const partial = installations.find((i) =>
      i.version.startsWith(majorMinor),
    );
    if (partial) return partial;
  }

  // Return newest
  return installations[0];
}

function tryParseInstallation(
  enginePath: string,
  platform: string,
): UEInstallation | null {
  const editorCmdRel = EDITOR_CMD_PATHS[platform];
  const runUATRel = RUN_UAT_PATHS[platform];
  if (!editorCmdRel || !runUATRel) return null;

  const editorCmdPath = join(enginePath, editorCmdRel);
  const runUATPath = join(enginePath, runUATRel);

  if (!existsSync(editorCmdPath)) return null;

  // Extract version from directory name (UE_5.7 -> 5.7)
  const dirName = enginePath.split("/").pop() || "";
  const versionMatch = dirName.match(/UE_(\d+\.\d+(?:\.\d+)?)/);
  const version = versionMatch ? versionMatch[1] : "unknown";

  return { version, path: enginePath, editorCmdPath, runUATPath };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export function clearCache(): void {
  cachedInstallations = null;
}
