import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// Platform-specific Build.sh / Build.bat — drives UBT for a single target.
const BUILD_SCRIPT_PATHS: Record<string, string> = {
  darwin: "Engine/Build/BatchFiles/Mac/Build.sh",
  win32: "Engine/Build/BatchFiles/Build.bat",
  linux: "Engine/Build/BatchFiles/Linux/Build.sh",
};

// Default platform name as UBT/UE expects it.
export const HOST_PLATFORM: Record<string, string> = {
  darwin: "Mac",
  win32: "Win64",
  linux: "Linux",
};

// Engine-registry files mapping a project's EngineAssociation GUID -> engine root.
// This is how the Epic launcher / Setup registers source & custom-built engines
// (e.g. a from-source build outside the standard install dir). Windows uses the
// registry (HKCU\Software\Epic Games\Unreal Engine\Builds) — not handled here yet.
const ENGINE_REGISTRY_INIS: Record<string, string[]> = {
  darwin: ["Library/Application Support/Epic/UnrealEngine/Install.ini"],
  linux: [".config/Epic/UnrealEngine/Install.ini"],
};

/** Strip braces/whitespace and upper-case so "{e338...}" and "E338..." compare equal. */
function normalizeGuid(s: string): string {
  return s.replace(/[{}\s]/g, "").toUpperCase();
}

/** GUID (normalized) -> engine root path, from the platform's engine registry. */
function readRegisteredEngines(): Record<string, string> {
  const out: Record<string, string> = {};
  const home = process.env.HOME || "";
  if (!home) return out;
  for (const rel of ENGINE_REGISTRY_INIS[process.platform] ?? []) {
    const ini = join(home, rel);
    if (!existsSync(ini)) continue;
    let inInstallations = false;
    for (const raw of readFileSync(ini, "utf-8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        inInstallations = /^\[installations\]$/i.test(line);
        continue;
      }
      const eq = line.indexOf("=");
      if (!inInstallations || eq < 0) continue;
      const guid = normalizeGuid(line.slice(0, eq));
      const path = line.slice(eq + 1).trim();
      if (guid && path) out[guid] = path;
    }
  }
  return out;
}

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

  // Registered engines (source / custom builds outside the standard dir), discovered
  // via the engine registry. Added AFTER the standard installs so that a plain version
  // match (e.g. "5.7") still prefers the stock install; a project that wants its source
  // engine selects it by GUID in findBestInstallation.
  for (const enginePath of Object.values(readRegisteredEngines())) {
    if (existsSync(enginePath) && !installations.some((i) => i.path === enginePath)) {
      const install = tryParseInstallation(enginePath, platform);
      if (install) installations.push(install);
    }
  }

  // Sort by version descending (newest first). Stable, so equal versions keep
  // insertion order (standard installs before registered source builds).
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
    // EngineAssociation is a GUID for source / custom-built engines — resolve it to the
    // engine that project is actually associated with (and built for) via the registry.
    const enginePath = readRegisteredEngines()[normalizeGuid(targetVersion)];
    if (enginePath) {
      const byPath = installations.find((i) => i.path === enginePath);
      if (byPath) return byPath;
    }

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
  const buildScriptRel = BUILD_SCRIPT_PATHS[platform];
  if (!editorCmdRel || !runUATRel || !buildScriptRel) return null;

  const editorCmdPath = join(enginePath, editorCmdRel);
  const runUATPath = join(enginePath, runUATRel);
  const buildScriptPath = join(enginePath, buildScriptRel);

  if (!existsSync(editorCmdPath)) return null;

  // Version: prefer the directory name (UE_5.7 -> 5.7); fall back to Engine/Build/Build.version
  // for source/custom builds whose folder isn't named UE_x.y.
  const dirName = enginePath.split("/").pop() || "";
  const versionMatch = dirName.match(/UE_(\d+\.\d+(?:\.\d+)?)/);
  let version = versionMatch ? versionMatch[1] : "unknown";
  if (version === "unknown") {
    try {
      const bv = JSON.parse(
        readFileSync(join(enginePath, "Engine/Build/Build.version"), "utf-8"),
      );
      if (typeof bv.MajorVersion === "number" && typeof bv.MinorVersion === "number") {
        version = `${bv.MajorVersion}.${bv.MinorVersion}`;
      }
    } catch {
      /* leave as "unknown" */
    }
  }

  return {
    version,
    path: enginePath,
    editorCmdPath,
    runUATPath,
    buildScriptPath,
  };
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
