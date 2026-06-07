import type { UEProject } from "../types/ue-project.js";
/** The most recently detected project, or undefined if no tool has run yet. */
export declare function getActiveProject(): UEProject | undefined;
export declare function detectProject(projectPath: string): UEProject;
/**
 * Convert a file path to a UE asset path.
 * e.g., /path/to/Project/Content/Blueprints/BP_Player.uasset -> /Game/Blueprints/BP_Player
 */
export declare function filePathToAssetPath(filePath: string, project: UEProject): string;
/**
 * Convert a UE asset path to a file path.
 * e.g., /Game/Blueprints/BP_Player -> /path/to/Project/Content/Blueprints/BP_Player.uasset
 */
export declare function assetPathToFilePath(assetPath: string, project: UEProject): string;
/**
 * Normalize user input to a valid asset path.
 * Accepts file paths, asset paths, or partial names.
 */
export declare function normalizeToAssetPath(input: string, project: UEProject): string;
export declare function clearCache(): void;
/**
 * Return the canonical log path for a project: `<Project>/Saved/Logs/<Project>.log`.
 *
 * UE's default log location varies by platform — Windows writes here; on
 * macOS UE writes to `~/Library/Logs/Unreal Engine/<TargetName>/<Project>.log`
 * by default. We normalise by passing `-AbsLog=<this path>` to every
 * launch so `read-logs` can find logs in one place regardless of host.
 */
export declare function defaultProjectLogPath(project: UEProject): string;
/**
 * Return platform-specific log paths UE writes to *outside* a project's
 * Saved/Logs folder. Used by `read-logs` as a fallback when the project's
 * Saved/Logs is empty (e.g. user opened UE manually rather than via this
 * plugin).
 *
 * macOS: `~/Library/Logs/Unreal Engine/<TargetName>/<Project>.log`
 *        Target name is usually `<Project>Editor` for editor sessions and
 *        `<Project>` for game runs.
 * Linux: `~/.config/Epic/UnrealEngine/Logs/<Project>.log` (rough; UE's Linux
 *        story has changed across versions).
 * Windows: UE writes to `<Project>/Saved/Logs/` by default; no fallback
 *          needed.
 */
export declare function platformLogFallbacks(project: UEProject): string[];
//# sourceMappingURL=project-detector.d.ts.map