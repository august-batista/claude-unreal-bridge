// Sandbox game target — used by packaged builds and standalone runs.
using UnrealBuildTool;
using System.Collections.Generic;

public class SandboxTarget : TargetRules
{
	public SandboxTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "Sandbox" });
	}
}
