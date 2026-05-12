import type { UEProject } from "../types/ue-project.js";
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
//# sourceMappingURL=project-detector.d.ts.map