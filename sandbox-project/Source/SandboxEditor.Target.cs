// Sandbox editor target — what we build to open the project headlessly.
using UnrealBuildTool;
using System.Collections.Generic;

public class SandboxEditorTarget : TargetRules
{
	public SandboxEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "Sandbox" });
	}
}
