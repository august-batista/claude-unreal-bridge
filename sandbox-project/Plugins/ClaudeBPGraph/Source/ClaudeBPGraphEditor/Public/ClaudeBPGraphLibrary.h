// Copyright (c) 2026 August / BearGame Team. MIT.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "ClaudeBPGraphLibrary.generated.h"

class UBlueprint;
class UWidgetBlueprint;

/**
 * Editor-only library for programmatic Blueprint (K2) graph editing, exposed to
 * Python via BlueprintCallable. Nodes are addressed by GUID string (FGuid::ToString)
 * so the read side (T3D extractor in extract_blueprint.py, which already emits node
 * GUIDs + pin IDs) and this write side line up. Graph is selected by name;
 * "" means the event graph (first ubergraph page).
 *
 * Wraps the standard editor APIs Epic's 5.8 BlueprintEditorLibrary uses internally
 * (FGraphNodeCreator, UEdGraphSchema::TryCreateConnection, UEdGraph::RemoveNode,
 * FKismetEditorUtilities::CompileBlueprint) — all present in UE 5.7, so this needs
 * no engine upgrade. Driven from Python by python-scripts/edit_blueprint_graph.py.
 */
UCLASS()
class UClaudeBPGraphLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Spawn a CallFunction node for FunctionOwner::FunctionName. Returns the new node's GUID string (empty on failure). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddFunctionCallNode(UBlueprint* Blueprint, const FString& GraphName, UClass* FunctionOwner, FName FunctionName, int32 NodePosX, int32 NodePosY);

	/** Spawn a Custom Event node named EventName. Returns the new node's GUID string (empty on failure). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddCustomEventNode(UBlueprint* Blueprint, const FString& GraphName, FName EventName, int32 NodePosX, int32 NodePosY);

	/** Connect an output pin on one node to an input pin on another (via the graph schema). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool ConnectPins(UBlueprint* Blueprint, const FString& GraphName, const FString& FromNodeId, FName FromPin, const FString& ToNodeId, FName ToPin);

	/** Returns true if FromNode.FromPin (output) is linked to ToNode.ToPin (input). For post-edit verification. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool AreNodesConnected(UBlueprint* Blueprint, const FString& GraphName, const FString& FromNodeId, FName FromPin, const FString& ToNodeId, FName ToPin);

	/** Set the literal default value on an unconnected input pin. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool SetPinDefault(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, FName PinName, const FString& Value);

	/** Delete a node by GUID (breaks all its links). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool DeleteNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId);

	/** Compile the blueprint. Returns true if it ended UpToDate (with or without warnings). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool CompileBlueprintAsset(UBlueprint* Blueprint);

	/** Debug/verify: returns "<guid>|<className>|<title>" for each node in the graph. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static TArray<FString> ListNodeGuids(UBlueprint* Blueprint, const FString& GraphName);

	/** Returns "<fromGuid>|<fromPin>|<toGuid>|<toPin>|<exec|data>" for each output->input link
	 *  in the graph — the live edge list, keyed the same way connect/breakPinLink address nodes. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static TArray<FString> ListGraphConnections(UBlueprint* Blueprint, const FString& GraphName);

	// ---- logic node types ----

	/** Spawn a pure Variable Get node for a self/member variable. Output data pin is named after the variable. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddVariableGetNode(UBlueprint* Blueprint, const FString& GraphName, FName VariableName, int32 NodePosX, int32 NodePosY);

	/** Spawn a Variable Set node for a self/member variable. Exec in "execute"/out "then"; input data pin named after the variable. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddVariableSetNode(UBlueprint* Blueprint, const FString& GraphName, FName VariableName, int32 NodePosX, int32 NodePosY);

	/** Spawn a Branch (if/then/else) node. Pins: exec in "execute", bool in "Condition", exec outs "then" (true) / "else" (false). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddBranchNode(UBlueprint* Blueprint, const FString& GraphName, int32 NodePosX, int32 NodePosY);

	/** Create a member variable on the blueprint, then refresh the skeleton so subsequent get/set nodes resolve it.
	 *  VarType is one of: int, bool, float, string, name, byte. Returns false on unknown type. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool AddMemberVariable(UBlueprint* Blueprint, FName VariableName, const FString& VarType, const FString& DefaultValue);

	/** Spawn an Execution Sequence node with NumOutputs exec output pins ("then_0", "then_1", ...). Min 2. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddSequenceNode(UBlueprint* Blueprint, const FString& GraphName, int32 NumOutputs, int32 NodePosX, int32 NodePosY);

	/** Spawn a standard-library macro instance: ForLoop, ForEachLoop, WhileLoop, Gate, DoOnce, FlipFlop, etc. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddMacroInstanceNode(UBlueprint* Blueprint, const FString& GraphName, FName MacroName, int32 NodePosX, int32 NodePosY);

	/** Spawn a Cast (DynamicCast) node to TargetClass. bPure = pure cast (no exec pins). Pins: "Object" in, "As<Class>" out. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddCastNode(UBlueprint* Blueprint, const FString& GraphName, UClass* TargetClass, bool bPure, int32 NodePosX, int32 NodePosY);

	/** Spawn a CallFunction node for a function on the blueprint itself or an inherited/parent class. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static FString AddSelfFunctionCallNode(UBlueprint* Blueprint, const FString& GraphName, FName FunctionName, int32 NodePosX, int32 NodePosY);

	// ---- surgical edits (modify a specific existing node in place) ----

	/** Break a single connection between an output pin (FromNode.FromPin) and an input pin (ToNode.ToPin). */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool BreakPinLink(UBlueprint* Blueprint, const FString& GraphName, const FString& FromNodeId, FName FromPin, const FString& ToNodeId, FName ToPin);

	/** Retarget a CallFunction node to a different function (FunctionOwner::FunctionName); reconstructs pins. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool RetargetFunctionNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, UClass* FunctionOwner, FName FunctionName);

	/** Change a Cast (DynamicCast) node's target class; reconstructs pins. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool RetargetCastNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, UClass* TargetClass);

	/** Change a Variable Get/Set node's referenced (self) variable; reconstructs pins. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool RetargetVariableNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, FName VariableName);

	/** Rename a Custom Event node. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool RenameCustomEventNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, FName NewName);

	// ---- layout ----

	/** Move a node to an explicit graph position. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool SetNodePosition(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, int32 NodePosX, int32 NodePosY);

	/** Auto-arrange the whole graph into a tidy left-to-right flow: nodes are columned by their
	 *  longest exec-distance from a root (events/entry), pure data nodes sit one column left of their
	 *  consumer, and each column is stacked vertically with generous spacing. Eliminates overlaps. */
	UFUNCTION(BlueprintCallable, Category = "Claude|BP Graph")
	static bool AutoLayoutGraph(UBlueprint* Blueprint, const FString& GraphName);

	// ---- UMG widget tree (Widget Blueprints) ----

	/** Construct a widget of WidgetClass named WidgetName in a Widget Blueprint's tree. If ParentName is
	 *  None/empty the widget becomes the tree root (or is added to the existing root panel); otherwise it
	 *  is added as a child of the named panel widget. ChildIndex < 0 appends. Returns the widget's name
	 *  (empty on failure). */
	UFUNCTION(BlueprintCallable, Category = "Claude|UMG")
	static FString AddWidgetToTree(UWidgetBlueprint* WidgetBlueprint, UClass* WidgetClass, FName WidgetName, FName ParentName, int32 ChildIndex);

	/** Position + size a widget that lives in a CanvasPanel slot (anchored top-left). bAutoSize lets the slot
	 *  size to content (SizeX/SizeY then ignored). Returns false if the widget isn't in a canvas slot. */
	UFUNCTION(BlueprintCallable, Category = "Claude|UMG")
	static bool SetCanvasSlotLayout(UWidgetBlueprint* WidgetBlueprint, FName WidgetName, float PosX, float PosY, float SizeX, float SizeY, float AlignmentX, float AlignmentY, bool bAutoSize);

	/** Debug/verify: returns "<name>|<className>|<parentName>" for each widget in the tree (parent empty = root). */
	UFUNCTION(BlueprintCallable, Category = "Claude|UMG")
	static TArray<FString> ListWidgets(UWidgetBlueprint* WidgetBlueprint);
};
