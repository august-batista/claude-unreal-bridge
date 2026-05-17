import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { findBestInstallation } from "./engine-locator.js";
const projectCache = new Map();
export function detectProject(projectPath) {
    const cached = projectCache.get(projectPath);
    if (cached)
        return cached;
    // Find .uproject file
    const uprojectFile = findUProjectFile(projectPath);
    if (!uprojectFile) {
        throw new Error(`No .uproject file found in ${projectPath}. Is this an Unreal Engine project?`);
    }
    // Parse the .uproject file
    const uprojectContent = readFileSync(uprojectFile, "utf-8");
    let uproject;
    try {
        uproject = JSON.parse(uprojectContent);
    }
    catch {
        throw new Error(`Failed to parse ${uprojectFile}: invalid JSON`);
    }
    const projectDir = dirname(uprojectFile);
    const projectName = basename(uprojectFile, ".uproject");
    const engineVersion = uproject.EngineAssociation || "unknown";
    // Find the matching UE installation
    const installation = findBestInstallation(engineVersion);
    if (!installation) {
        throw new Error(`No Unreal Engine installation found for version ${engineVersion}. ` +
            `Set UE_ROOT environment variable to your UE installation path.`);
    }
    const contentPath = join(projectDir, "Content");
    const sourcePath = join(projectDir, "Source");
    const project = {
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
function findUProjectFile(searchPath) {
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
    if (uprojectFiles.length === 0)
        return null;
    if (uprojectFiles.length > 1) {
        console.error(`Multiple .uproject files found, using ${uprojectFiles[0]}`);
    }
    return join(searchPath, uprojectFiles[0]);
}
/**
 * Convert a file path to a UE asset path.
 * e.g., /path/to/Project/Content/Blueprints/BP_Player.uasset -> /Game/Blueprints/BP_Player
 */
export function filePathToAssetPath(filePath, project) {
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
export function assetPathToFilePath(assetPath, project) {
    // /Game/... maps to Content/...
    let rel = assetPath;
    if (rel.startsWith("/Game/")) {
        rel = rel.substring("/Game/".length);
    }
    else if (rel.startsWith("/game/")) {
        rel = rel.substring("/game/".length);
    }
    return join(project.contentPath, `${rel}.uasset`);
}
/**
 * Normalize user input to a valid asset path.
 * Accepts file paths, asset paths, or partial names.
 */
export function normalizeToAssetPath(input, project) {
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
export function clearCache() {
    projectCache.clear();
}
/**
 * Return the canonical log path for a project: `<Project>/Saved/Logs/<Project>.log`.
 *
 * UE's default log location varies by platform — Windows writes here; on
 * macOS UE writes to `~/Library/Logs/Unreal Engine/<TargetName>/<Project>.log`
 * by default. We normalise by passing `-AbsLog=<this path>` to every
 * launch so `read-logs` can find logs in one place regardless of host.
 */
export function defaultProjectLogPath(project) {
    return join(project.projectPath, "Saved", "Logs", `${project.projectName}.log`);
}
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
export function platformLogFallbacks(project) {
    const homeDir = process.env.HOME || "";
    if (!homeDir)
        return [];
    const fallbacks = [];
    if (process.platform === "darwin") {
        const root = join(homeDir, "Library", "Logs", "Unreal Engine");
        // Try the editor target first (most common for our launches), then game.
        fallbacks.push(join(root, `${project.projectName}Editor`, `${project.projectName}.log`), join(root, project.projectName, `${project.projectName}.log`));
    }
    else if (process.platform === "linux") {
        fallbacks.push(join(homeDir, ".config", "Epic", "UnrealEngine", "Logs", `${project.projectName}.log`));
    }
    return fallbacks;
}
//# sourceMappingURL=project-detector.js.map