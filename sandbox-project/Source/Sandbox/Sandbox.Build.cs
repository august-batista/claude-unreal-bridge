// Primary game module for the Sandbox project.
using UnrealBuildTool;

public class Sandbox : ModuleRules
{
	public Sandbox(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[] {
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
		});

		PrivateDependencyModuleNames.AddRange(new string[] {
			// Add private deps here as the sandbox grows.
		});
	}
}
