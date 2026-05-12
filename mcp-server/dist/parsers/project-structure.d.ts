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
export declare function scanProjectStructure(project: UEProject): ProjectOverview;
/**
 * Format a project overview as markdown.
 */
export declare function formatProjectOverview(overview: ProjectOverview): string;
//# sourceMappingURL=project-structure.d.ts.map