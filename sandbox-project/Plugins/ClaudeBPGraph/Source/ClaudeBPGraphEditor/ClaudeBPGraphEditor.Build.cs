// Spike module for claude-unreal Blueprint node-editing. Editor-only.
using UnrealBuildTool;

public class ClaudeBPGraphEditor : ModuleRules
{
    public ClaudeBPGraphEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "UnrealEd",        // FKismetEditorUtilities, FBlueprintEditorUtils
            "BlueprintGraph",  // UK2Node_CallFunction, UK2Node_CustomEvent
        });
    }
}
