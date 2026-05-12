export interface UEInstallation {
  version: string;
  path: string;
  editorCmdPath: string;
  runUATPath: string;
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
  summary: string;
}

export interface CompileMessage {
  blueprint?: string;
  message: string;
  severity: "error" | "warning";
  line?: string;
}
