export interface UEInstallation {
    version: string;
    path: string;
    editorCmdPath: string;
    runUATPath: string;
    buildScriptPath: string;
}
export interface UEProject {
    projectPath: string;
    projectName: string;
    uprojectFile: string;
    engineVersion: string;
    enginePath: string;
    contentPath: string;
    sourcePath?: string;
    modules: string[];
    plugins: PluginRef[];
}
export interface PluginRef {
    name: string;
    enabled: boolean;
}
export interface UProjectFile {
    FileVersion: number;
    EngineAssociation: string;
    Category?: string;
    Description?: string;
    Modules?: {
        Name: string;
        Type: string;
        LoadingPhase: string;
    }[];
    Plugins?: {
        Name: string;
        Enabled: boolean;
    }[];
}
export interface CompileResult {
    success: boolean;
    errors: CompileMessage[];
    warnings: CompileMessage[];
    totals?: CompileTotals;
    summary: string;
    exitCode: number | null;
}
export interface CompileMessage {
    blueprint?: string;
    category: string;
    message: string;
    severity: "error" | "warning";
    line: string;
}
export interface CompileTotals {
    successful: number;
    failed: number;
    failedBlueprints?: string[];
}
export type BuildConfiguration = "Debug" | "DebugGame" | "Development" | "Shipping" | "Test";
export interface CppBuildResult {
    success: boolean;
    target: string;
    platform: string;
    configuration: BuildConfiguration;
    errors: CppBuildMessage[];
    warnings: CppBuildMessage[];
    summary: string;
    exitCode: number | null;
    durationMs: number;
}
export interface CppBuildMessage {
    file?: string;
    line?: number;
    column?: number;
    code?: string;
    message: string;
    severity: "error" | "warning";
    raw: string;
}
//# sourceMappingURL=ue-project.d.ts.map