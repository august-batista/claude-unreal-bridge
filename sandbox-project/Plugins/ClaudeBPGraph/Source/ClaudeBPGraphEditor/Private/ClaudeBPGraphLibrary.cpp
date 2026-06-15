// Copyright (c) 2026 August / BearGame Team. MIT.
#include "ClaudeBPGraphLibrary.h"

#include "Engine/Blueprint.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraph/EdGraphSchema.h"
#include "K2Node_CallFunction.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_Variable.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_ExecutionSequence.h"
#include "K2Node_MacroInstance.h"
#include "K2Node_DynamicCast.h"
#include "EdGraphSchema_K2.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "UObject/UObjectGlobals.h"
#include "WidgetBlueprint.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Widget.h"
#include "Components/PanelWidget.h"
#include "Components/PanelSlot.h"
#include "Components/CanvasPanelSlot.h"

namespace
{
	// Resolve a graph by name. Empty name -> the event graph (first ubergraph page).
	UEdGraph* ResolveGraph(UBlueprint* Blueprint, const FString& GraphName)
	{
		if (!Blueprint)
		{
			return nullptr;
		}
		if (GraphName.IsEmpty())
		{
			return Blueprint->UbergraphPages.Num() > 0 ? Blueprint->UbergraphPages[0] : nullptr;
		}
		TArray<UEdGraph*> AllGraphs;
		Blueprint->GetAllGraphs(AllGraphs);
		for (UEdGraph* Graph : AllGraphs)
		{
			if (Graph && Graph->GetName() == GraphName)
			{
				return Graph;
			}
		}
		return nullptr;
	}

	UEdGraphNode* FindNodeByGuid(UEdGraph* Graph, const FString& NodeId)
	{
		FGuid Guid;
		if (!Graph || !FGuid::Parse(NodeId, Guid))
		{
			return nullptr;
		}
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (Node && Node->NodeGuid == Guid)
			{
				return Node;
			}
		}
		return nullptr;
	}

	// ---- auto-layout helpers ----

	bool LayoutIsExecPin(const UEdGraphPin* Pin)
	{
		return Pin && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec;
	}

	bool LayoutIsPure(UEdGraphNode* Node)
	{
		if (!Node)
		{
			return true;
		}
		for (const UEdGraphPin* Pin : Node->Pins)
		{
			if (LayoutIsExecPin(Pin))
			{
				return false;
			}
		}
		return true;
	}

	// Rough headless size estimates — true sizes live in Slate at draw time, so layout
	// uses these to keep wide nodes (e.g. Print String) from crowding their neighbours.
	int32 LayoutEstWidth(UEdGraphNode* Node)
	{
		const FString Cls = Node->GetClass()->GetName();
		int32 W = 160;
		if (Cls.Contains(TEXT("VariableGet"))) { W = 130; }
		else if (Cls.Contains(TEXT("VariableSet"))) { W = 200; }
		else if (Cls.Contains(TEXT("IfThenElse"))) { W = 170; }
		else if (Cls.Contains(TEXT("CallFunction"))) { W = 210; }
		else if (Cls.Contains(TEXT("Event"))) { W = 180; }
		const int32 TitleLen = Node->GetNodeTitle(ENodeTitleType::ListView).ToString().Len();
		W = FMath::Max(W, 120 + TitleLen * 5);
		return FMath::Clamp(W, 130, 340);
	}

	int32 LayoutEstHeight(UEdGraphNode* Node)
	{
		int32 In = 0, Out = 0;
		for (const UEdGraphPin* Pin : Node->Pins)
		{
			// Skip hidden + collapsed advanced ("Development Only") pins — they don't
			// add to the node's default on-screen height.
			if (!Pin || Pin->bHidden || Pin->bAdvancedView)
			{
				continue;
			}
			if (Pin->Direction == EGPD_Input) { ++In; } else { ++Out; }
		}
		return 80 + FMath::Max(In, Out) * 28;
	}

	// Estimated vertical offset (from the node's top) of its primary exec pin. Used to align
	// exec pins to a common rail so exec wires come out near-straight. Approximate — true pin
	// geometry lives in Slate; most nodes have exec as the first pin so this ~= top alignment.
	int32 LayoutExecPinOffset(UEdGraphNode* Node)
	{
		const int32 HEADER = 38;
		const int32 ROW = 28;
		// Prefer the exec INPUT pin (where an incoming wire lands); fall back to exec OUTPUT.
		for (int32 Pass = 0; Pass < 2; ++Pass)
		{
			const EEdGraphPinDirection Want = (Pass == 0) ? EGPD_Input : EGPD_Output;
			int32 Vis = 0;
			for (const UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin || Pin->bHidden || Pin->bAdvancedView || Pin->Direction != Want)
				{
					continue;
				}
				if (LayoutIsExecPin(Pin))
				{
					return HEADER + Vis * ROW;
				}
				++Vis;
			}
		}
		return HEADER;
	}

	TArray<UEdGraphNode*> LayoutExecOutTargets(UEdGraphNode* Node)
	{
		TArray<UEdGraphNode*> Out;
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (Pin->Direction == EGPD_Output && LayoutIsExecPin(Pin))
			{
				for (UEdGraphPin* L : Pin->LinkedTo)
				{
					if (L && L->GetOwningNode())
					{
						Out.AddUnique(L->GetOwningNode());
					}
				}
			}
		}
		return Out;
	}

	TArray<UEdGraphNode*> LayoutDataSources(UEdGraphNode* Node)
	{
		TArray<UEdGraphNode*> Out;
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (Pin->Direction == EGPD_Input && !LayoutIsExecPin(Pin))
			{
				for (UEdGraphPin* L : Pin->LinkedTo)
				{
					UEdGraphNode* S = L ? L->GetOwningNode() : nullptr;
					if (S && LayoutIsPure(S))
					{
						Out.AddUnique(S);
					}
				}
			}
		}
		return Out;
	}

	const int32 LayoutDataHGap = 40;

	// Collect a consumer's transitive pure data feeders in data-flow order (sources first),
	// e.g. for a Branch fed by "A > B" fed by "Get Health" -> [Get Health, "A > B"].
	void LayoutCollectFeeders(UEdGraphNode* Node, TArray<UEdGraphNode*>& Order, TSet<UEdGraphNode*>& Seen)
	{
		for (UEdGraphNode* Src : LayoutDataSources(Node))
		{
			if (Seen.Contains(Src))
			{
				continue;
			}
			Seen.Add(Src);
			LayoutCollectFeeders(Src, Order, Seen);
			Order.Add(Src);
		}
	}

	TArray<UEdGraphNode*> LayoutFeederChain(UEdGraphNode* Consumer)
	{
		TArray<UEdGraphNode*> Order;
		TSet<UEdGraphNode*> Seen;
		LayoutCollectFeeders(Consumer, Order, Seen);
		return Order;
	}

	// Total horizontal width a feeder chain occupies when laid left-to-right.
	int32 LayoutFeederChainWidth(const TArray<UEdGraphNode*>& Chain)
	{
		int32 W = 0;
		for (int32 i = 0; i < Chain.Num(); ++i)
		{
			W += LayoutEstWidth(Chain[i]);
			if (i > 0)
			{
				W += LayoutDataHGap;
			}
		}
		return W;
	}

	// Place the exec backbone left-to-right at a single row; the first exec output stays on
	// the row (straight wire), additional outputs (e.g. Branch's False) drop to lower rows.
	// Data feeders are NOT placed here — that's a second pass once the row height is known.
	void LayoutPlaceExec(UEdGraphNode* Node, int32 X, int32 RailY,
		TSet<UEdGraphNode*>& Placed, TMap<UEdGraphNode*, FIntPoint>& Pos,
		TArray<UEdGraphNode*>& ExecOrder)
	{
		if (!Node || Placed.Contains(Node))
		{
			return;
		}
		const int32 HGAP = 70;
		const int32 BRANCH_DROP = 240;
		// Place the node so its exec pin lands on RailY → level exec wires between nodes.
		const int32 Top = RailY - LayoutExecPinOffset(Node);
		Placed.Add(Node);
		Pos.Add(Node, FIntPoint(X, Top));
		ExecOrder.Add(Node);
		const int32 NodeRight = X + LayoutEstWidth(Node);
		const TArray<UEdGraphNode*> Targets = LayoutExecOutTargets(Node);
		for (int32 i = 0; i < Targets.Num(); ++i)
		{
			// Widen the gap before a target so its data-feeder chain fits in the gap below
			// the line (feeders flow left-to-right, the last ending just before the target).
			const TArray<UEdGraphNode*> Chain = LayoutFeederChain(Targets[i]);
			const int32 ChainW = LayoutFeederChainWidth(Chain);
			const int32 Gap = HGAP + (Chain.Num() > 0 ? ChainW + HGAP : 0);
			LayoutPlaceExec(Targets[i], NodeRight + Gap, RailY + i * BRANCH_DROP, Placed, Pos, ExecOrder);
		}
	}
}

FString UClaudeBPGraphLibrary::AddFunctionCallNode(UBlueprint* Blueprint, const FString& GraphName, UClass* FunctionOwner, FName FunctionName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph || !FunctionOwner)
	{
		return FString();
	}
	UFunction* Function = FunctionOwner->FindFunctionByName(FunctionName);
	if (!Function)
	{
		return FString();
	}

	FGraphNodeCreator<UK2Node_CallFunction> Creator(*Graph);
	UK2Node_CallFunction* Node = Creator.CreateNode();
	Node->SetFromFunction(Function);
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

FString UClaudeBPGraphLibrary::AddCustomEventNode(UBlueprint* Blueprint, const FString& GraphName, FName EventName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}

	FGraphNodeCreator<UK2Node_CustomEvent> Creator(*Graph);
	UK2Node_CustomEvent* Node = Creator.CreateNode();
	Node->CustomFunctionName = EventName;
	Node->bIsEditable = true;
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

bool UClaudeBPGraphLibrary::ConnectPins(UBlueprint* Blueprint, const FString& GraphName, const FString& FromNodeId, FName FromPin, const FString& ToNodeId, FName ToPin)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UEdGraphNode* FromNode = FindNodeByGuid(Graph, FromNodeId);
	UEdGraphNode* ToNode = FindNodeByGuid(Graph, ToNodeId);
	if (!FromNode || !ToNode)
	{
		return false;
	}
	UEdGraphPin* PinA = FromNode->FindPin(FromPin, EGPD_Output);
	UEdGraphPin* PinB = ToNode->FindPin(ToPin, EGPD_Input);
	if (!PinA || !PinB)
	{
		return false;
	}
	const UEdGraphSchema* Schema = Graph->GetSchema();
	if (!Schema)
	{
		return false;
	}
	const bool bConnected = Schema->TryCreateConnection(PinA, PinB);
	if (bConnected)
	{
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	}
	return bConnected;
}

bool UClaudeBPGraphLibrary::AreNodesConnected(UBlueprint* Blueprint, const FString& GraphName, const FString& FromNodeId, FName FromPin, const FString& ToNodeId, FName ToPin)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UEdGraphNode* FromNode = FindNodeByGuid(Graph, FromNodeId);
	UEdGraphNode* ToNode = FindNodeByGuid(Graph, ToNodeId);
	if (!FromNode || !ToNode)
	{
		return false;
	}
	UEdGraphPin* PinA = FromNode->FindPin(FromPin, EGPD_Output);
	UEdGraphPin* PinB = ToNode->FindPin(ToPin, EGPD_Input);
	if (!PinA || !PinB)
	{
		return false;
	}
	return PinA->LinkedTo.Contains(PinB);
}

bool UClaudeBPGraphLibrary::SetPinDefault(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, FName PinName, const FString& Value)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UEdGraphNode* Node = FindNodeByGuid(Graph, NodeId);
	if (!Node)
	{
		return false;
	}
	UEdGraphPin* Pin = Node->FindPin(PinName, EGPD_Input);
	if (!Pin)
	{
		return false;
	}
	const UEdGraphSchema* Schema = Graph->GetSchema();
	if (!Schema)
	{
		return false;
	}
	Schema->TrySetDefaultValue(*Pin, Value);
	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::DeleteNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UEdGraphNode* Node = FindNodeByGuid(Graph, NodeId);
	if (!Node)
	{
		return false;
	}
	FBlueprintEditorUtils::RemoveNode(Blueprint, Node, /*bDontRecompile=*/true);
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::CompileBlueprintAsset(UBlueprint* Blueprint)
{
	if (!Blueprint)
	{
		return false;
	}
	FKismetEditorUtilities::CompileBlueprint(Blueprint);
	return Blueprint->Status == EBlueprintStatus::BS_UpToDate
		|| Blueprint->Status == EBlueprintStatus::BS_UpToDateWithWarnings;
}

TArray<FString> UClaudeBPGraphLibrary::ListNodeGuids(UBlueprint* Blueprint, const FString& GraphName)
{
	TArray<FString> Out;
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return Out;
	}
	for (UEdGraphNode* Node : Graph->Nodes)
	{
		if (!Node)
		{
			continue;
		}
		const FString Title = Node->GetNodeTitle(ENodeTitleType::ListView).ToString();
		Out.Add(FString::Printf(TEXT("%s|%s|%s|%d,%d"), *Node->NodeGuid.ToString(), *Node->GetClass()->GetName(), *Title, Node->NodePosX, Node->NodePosY));
	}
	return Out;
}

TArray<FString> UClaudeBPGraphLibrary::ListGraphConnections(UBlueprint* Blueprint, const FString& GraphName)
{
	TArray<FString> Out;
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return Out;
	}
	for (UEdGraphNode* Node : Graph->Nodes)
	{
		if (!Node)
		{
			continue;
		}
		const FString FromGuid = Node->NodeGuid.ToString();
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (!Pin || Pin->Direction != EGPD_Output)
			{
				continue;
			}
			const bool bExec = (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec);
			for (UEdGraphPin* Linked : Pin->LinkedTo)
			{
				UEdGraphNode* ToNode = Linked ? Linked->GetOwningNode() : nullptr;
				if (!ToNode)
				{
					continue;
				}
				Out.Add(FString::Printf(TEXT("%s|%s|%s|%s|%s"),
					*FromGuid, *Pin->PinName.ToString(),
					*ToNode->NodeGuid.ToString(), *Linked->PinName.ToString(),
					bExec ? TEXT("exec") : TEXT("data")));
			}
		}
	}
	return Out;
}

FString UClaudeBPGraphLibrary::AddVariableGetNode(UBlueprint* Blueprint, const FString& GraphName, FName VariableName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_VariableGet> Creator(*Graph);
	UK2Node_VariableGet* Node = Creator.CreateNode();
	Node->VariableReference.SetSelfMember(VariableName);
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

FString UClaudeBPGraphLibrary::AddVariableSetNode(UBlueprint* Blueprint, const FString& GraphName, FName VariableName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_VariableSet> Creator(*Graph);
	UK2Node_VariableSet* Node = Creator.CreateNode();
	Node->VariableReference.SetSelfMember(VariableName);
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

FString UClaudeBPGraphLibrary::AddBranchNode(UBlueprint* Blueprint, const FString& GraphName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_IfThenElse> Creator(*Graph);
	UK2Node_IfThenElse* Node = Creator.CreateNode();
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

bool UClaudeBPGraphLibrary::AddMemberVariable(UBlueprint* Blueprint, FName VariableName, const FString& VarType, const FString& DefaultValue)
{
	if (!Blueprint)
	{
		return false;
	}

	FEdGraphPinType PinType;
	const FString T = VarType.ToLower();
	if (T == TEXT("int") || T == TEXT("integer"))
	{
		PinType.PinCategory = UEdGraphSchema_K2::PC_Int;
	}
	else if (T == TEXT("bool") || T == TEXT("boolean"))
	{
		PinType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
	}
	else if (T == TEXT("float") || T == TEXT("double") || T == TEXT("real"))
	{
		PinType.PinCategory = UEdGraphSchema_K2::PC_Real;
		PinType.PinSubCategory = UEdGraphSchema_K2::PC_Double;
	}
	else if (T == TEXT("string"))
	{
		PinType.PinCategory = UEdGraphSchema_K2::PC_String;
	}
	else if (T == TEXT("name"))
	{
		PinType.PinCategory = UEdGraphSchema_K2::PC_Name;
	}
	else if (T == TEXT("byte"))
	{
		PinType.PinCategory = UEdGraphSchema_K2::PC_Byte;
	}
	else
	{
		return false;
	}

	const bool bAdded = FBlueprintEditorUtils::AddMemberVariable(Blueprint, VariableName, PinType, DefaultValue);
	if (bAdded)
	{
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
		// Refresh the skeleton so VariableGet/Set nodes created later in the same
		// session resolve this variable's type and allocate their data pins.
		FKismetEditorUtilities::GenerateBlueprintSkeleton(Blueprint, /*bForceRegeneration=*/true);
	}
	return bAdded;
}

FString UClaudeBPGraphLibrary::AddSequenceNode(UBlueprint* Blueprint, const FString& GraphName, int32 NumOutputs, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_ExecutionSequence> Creator(*Graph);
	UK2Node_ExecutionSequence* Node = Creator.CreateNode();
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();
	// Default node has two exec outputs (then_0, then_1); add more if requested.
	for (int32 i = 2; i < NumOutputs; ++i)
	{
		Node->AddInputPin();
	}
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

FString UClaudeBPGraphLibrary::AddMacroInstanceNode(UBlueprint* Blueprint, const FString& GraphName, FName MacroName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}
	UBlueprint* MacroLib = LoadObject<UBlueprint>(nullptr, TEXT("/Engine/EditorBlueprintResources/StandardMacros.StandardMacros"));
	if (!MacroLib)
	{
		return FString();
	}
	UEdGraph* MacroGraph = nullptr;
	for (UEdGraph* G : MacroLib->MacroGraphs)
	{
		if (G && G->GetFName() == MacroName)
		{
			MacroGraph = G;
			break;
		}
	}
	if (!MacroGraph)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_MacroInstance> Creator(*Graph);
	UK2Node_MacroInstance* Node = Creator.CreateNode();
	Node->SetMacroGraph(MacroGraph);
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

FString UClaudeBPGraphLibrary::AddCastNode(UBlueprint* Blueprint, const FString& GraphName, UClass* TargetClass, bool bPure, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph || !TargetClass)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_DynamicCast> Creator(*Graph);
	UK2Node_DynamicCast* Node = Creator.CreateNode();
	Node->TargetType = TargetClass;
	Node->SetPurity(bPure);
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

FString UClaudeBPGraphLibrary::AddSelfFunctionCallNode(UBlueprint* Blueprint, const FString& GraphName, FName FunctionName, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return FString();
	}
	UClass* SelfClass = Blueprint->SkeletonGeneratedClass;
	if (!SelfClass)
	{
		SelfClass = Blueprint->GeneratedClass;
	}
	if (!SelfClass)
	{
		return FString();
	}
	UFunction* Function = SelfClass->FindFunctionByName(FunctionName);
	if (!Function)
	{
		return FString();
	}
	FGraphNodeCreator<UK2Node_CallFunction> Creator(*Graph);
	UK2Node_CallFunction* Node = Creator.CreateNode();
	Node->SetFromFunction(Function);
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	Creator.Finalize();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return Node->NodeGuid.ToString();
}

bool UClaudeBPGraphLibrary::BreakPinLink(UBlueprint* Blueprint, const FString& GraphName, const FString& FromNodeId, FName FromPin, const FString& ToNodeId, FName ToPin)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UEdGraphNode* FromNode = FindNodeByGuid(Graph, FromNodeId);
	UEdGraphNode* ToNode = FindNodeByGuid(Graph, ToNodeId);
	if (!FromNode || !ToNode)
	{
		return false;
	}
	UEdGraphPin* PinA = FromNode->FindPin(FromPin, EGPD_Output);
	UEdGraphPin* PinB = ToNode->FindPin(ToPin, EGPD_Input);
	if (!PinA || !PinB)
	{
		return false;
	}
	const UEdGraphSchema* Schema = Graph->GetSchema();
	if (!Schema)
	{
		return false;
	}
	Schema->BreakSinglePinLink(PinA, PinB);
	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::RetargetFunctionNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, UClass* FunctionOwner, FName FunctionName)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph || !FunctionOwner)
	{
		return false;
	}
	UK2Node_CallFunction* Node = Cast<UK2Node_CallFunction>(FindNodeByGuid(Graph, NodeId));
	if (!Node)
	{
		return false;
	}
	UFunction* Function = FunctionOwner->FindFunctionByName(FunctionName);
	if (!Function)
	{
		return false;
	}
	Node->SetFromFunction(Function);
	Node->ReconstructNode();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::RetargetCastNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, UClass* TargetClass)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph || !TargetClass)
	{
		return false;
	}
	UK2Node_DynamicCast* Node = Cast<UK2Node_DynamicCast>(FindNodeByGuid(Graph, NodeId));
	if (!Node)
	{
		return false;
	}
	Node->TargetType = TargetClass;
	Node->ReconstructNode();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::RetargetVariableNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, FName VariableName)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UK2Node_Variable* Node = Cast<UK2Node_Variable>(FindNodeByGuid(Graph, NodeId));
	if (!Node)
	{
		return false;
	}
	Node->VariableReference.SetSelfMember(VariableName);
	Node->ReconstructNode();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::RenameCustomEventNode(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, FName NewName)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UK2Node_CustomEvent* Node = Cast<UK2Node_CustomEvent>(FindNodeByGuid(Graph, NodeId));
	if (!Node)
	{
		return false;
	}
	Node->CustomFunctionName = NewName;
	Node->ReconstructNode();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::SetNodePosition(UBlueprint* Blueprint, const FString& GraphName, const FString& NodeId, int32 NodePosX, int32 NodePosY)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}
	UEdGraphNode* Node = FindNodeByGuid(Graph, NodeId);
	if (!Node)
	{
		return false;
	}
	Node->Modify();
	Node->NodePosX = NodePosX;
	Node->NodePosY = NodePosY;
	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	return true;
}

bool UClaudeBPGraphLibrary::AutoLayoutGraph(UBlueprint* Blueprint, const FString& GraphName)
{
	UEdGraph* Graph = ResolveGraph(Blueprint, GraphName);
	if (!Graph)
	{
		return false;
	}

	TSet<UEdGraphNode*> Placed;
	TMap<UEdGraphNode*, FIntPoint> Pos;

	// Roots = exec nodes that START a chain: an exec-output link, no exec-input link.
	// (Disconnected events like ActorBeginOverlap/Tick have no exec links -> not roots.)
	TArray<UEdGraphNode*> Roots;
	for (UEdGraphNode* N : Graph->Nodes)
	{
		if (!N)
		{
			continue;
		}
		bool bHasExecOutLink = false;
		bool bHasExecInLink = false;
		for (UEdGraphPin* Pin : N->Pins)
		{
			if (!LayoutIsExecPin(Pin))
			{
				continue;
			}
			if (Pin->Direction == EGPD_Output && Pin->LinkedTo.Num() > 0) { bHasExecOutLink = true; }
			if (Pin->Direction == EGPD_Input && Pin->LinkedTo.Num() > 0) { bHasExecInLink = true; }
		}
		if (bHasExecOutLink && !bHasExecInLink)
		{
			Roots.Add(N);
		}
	}
	// Anchor Event BeginPlay at the top-left when present.
	Roots.Sort([](UEdGraphNode& A, UEdGraphNode& B)
	{
		const bool bA = A.GetNodeTitle(ENodeTitleType::ListView).ToString().Contains(TEXT("BeginPlay"));
		const bool bB = B.GetNodeTitle(ENodeTitleType::ListView).ToString().Contains(TEXT("BeginPlay"));
		return bA && !bB;
	});

	// Pass 1: place the exec backbone(s); collect the placed exec nodes in order.
	// RailBase aligns the first row's exec pins to y≈38 so node tops land near y=0.
	TArray<UEdGraphNode*> ExecOrder;
	const int32 RootBand = 700;
	const int32 RailBase = 38;
	for (int32 i = 0; i < Roots.Num(); ++i)
	{
		LayoutPlaceExec(Roots[i], 0, RailBase + i * RootBand, Placed, Pos, ExecOrder);
	}

	// Pass 2: place each exec node's data feeders on a band a fixed distance below the exec
	// row. Feeders now sit in the horizontal gap before their consumer (nothing is directly
	// above them), so this original modest offset is enough — no need to push them lower.
	const int32 BandOffset = 170;
	const int32 FeederHGap = 70;
	for (UEdGraphNode* N : ExecOrder)
	{
		const TArray<UEdGraphNode*> Chain = LayoutFeederChain(N);
		if (Chain.Num() == 0)
		{
			continue;
		}
		const FIntPoint NP = Pos[N];
		const int32 BandY = NP.Y + BandOffset;
		// Lay the chain left-to-right in the gap reserved before N (data-flow order:
		// sources first), so e.g. Get Health sits AFTER Set Health and feeds rightward
		// into the Branch's Condition.
		int32 FX = NP.X - FeederHGap - LayoutFeederChainWidth(Chain);
		for (UEdGraphNode* F : Chain)
		{
			if (!Placed.Contains(F))
			{
				Placed.Add(F);
				Pos.Add(F, FIntPoint(FX, BandY));
			}
			FX += LayoutEstWidth(F) + LayoutDataHGap;
		}
	}

	// Park anything still unplaced (disconnected events, orphan data) in a column lower-left.
	int32 MaxY = 0;
	for (const TPair<UEdGraphNode*, FIntPoint>& P : Pos)
	{
		MaxY = FMath::Max(MaxY, P.Value.Y);
	}
	int32 ParkY = MaxY + 260;
	for (UEdGraphNode* N : Graph->Nodes)
	{
		if (!N || Placed.Contains(N))
		{
			continue;
		}
		Placed.Add(N);
		Pos.Add(N, FIntPoint(0, ParkY));
		ParkY += LayoutEstHeight(N) + 60;
	}

	// Commit positions.
	for (const TPair<UEdGraphNode*, FIntPoint>& P : Pos)
	{
		if (!P.Key)
		{
			continue;
		}
		P.Key->Modify();
		P.Key->NodePosX = P.Value.X;
		P.Key->NodePosY = P.Value.Y;
	}

	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	return true;
}

// ---- UMG widget tree (Widget Blueprints) ----
// Cribbed from UE 5.8's UMGToolSet::AddWidget (WidgetTree->ConstructWidget + OnVariableAdded +
// RootWidget / panel AddChild) — all plain UMG/UMGEditor C++ present in 5.7, no engine upgrade.

FString UClaudeBPGraphLibrary::AddWidgetToTree(UWidgetBlueprint* WidgetBlueprint, UClass* WidgetClass, FName WidgetName, FName ParentName, int32 ChildIndex)
{
	if (!WidgetBlueprint || !WidgetClass || WidgetName.IsNone())
	{
		return FString();
	}
	if (WidgetClass->HasAnyClassFlags(CLASS_Abstract) || !WidgetClass->IsChildOf(UWidget::StaticClass()))
	{
		return FString();
	}
	UWidgetTree* Tree = WidgetBlueprint->WidgetTree;
	if (!Tree)
	{
		return FString();
	}
	if (Tree->FindWidget(WidgetName))
	{
		return FString();   // name already in use
	}

	WidgetBlueprint->Modify();
	UWidget* NewWidget = Tree->ConstructWidget<UWidget>(WidgetClass, WidgetName);
	if (!NewWidget)
	{
		return FString();
	}
	// Surface the widget as a blueprint variable so it's addressable from graphs.
	if (!WidgetBlueprint->WidgetVariableNameToGuidMap.Contains(NewWidget->GetFName()))
	{
		WidgetBlueprint->OnVariableAdded(NewWidget->GetFName());
	}

	UPanelWidget* TargetPanel = nullptr;
	if (ParentName.IsNone())
	{
		// No parent named: become the root, or (if a root exists) attach to the root panel.
		if (!Tree->RootWidget)
		{
			Tree->RootWidget = NewWidget;
			WidgetBlueprint->MarkPackageDirty();
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBlueprint);
			return NewWidget->GetName();
		}
		TargetPanel = Cast<UPanelWidget>(Tree->RootWidget);
	}
	else
	{
		TargetPanel = Cast<UPanelWidget>(Tree->FindWidget(ParentName));
	}
	if (!TargetPanel)
	{
		return FString();   // parent missing or not a panel widget
	}

	UPanelSlot* Slot = (ChildIndex >= 0)
		? TargetPanel->InsertChildAt(ChildIndex, NewWidget)
		: TargetPanel->AddChild(NewWidget);
	if (!Slot)
	{
		return FString();   // panel rejected the child (e.g. a content widget already has one)
	}

	WidgetBlueprint->MarkPackageDirty();
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBlueprint);
	return NewWidget->GetName();
}

bool UClaudeBPGraphLibrary::SetCanvasSlotLayout(UWidgetBlueprint* WidgetBlueprint, FName WidgetName, float PosX, float PosY, float SizeX, float SizeY, float AlignmentX, float AlignmentY, bool bAutoSize)
{
	if (!WidgetBlueprint || !WidgetBlueprint->WidgetTree)
	{
		return false;
	}
	UWidget* W = WidgetBlueprint->WidgetTree->FindWidget(WidgetName);
	if (!W)
	{
		return false;
	}
	UCanvasPanelSlot* Slot = Cast<UCanvasPanelSlot>(W->Slot);
	if (!Slot)
	{
		return false;   // not parented under a CanvasPanel
	}
	Slot->SetPosition(FVector2D(PosX, PosY));
	Slot->SetAlignment(FVector2D(AlignmentX, AlignmentY));
	Slot->SetAutoSize(bAutoSize);
	if (!bAutoSize)
	{
		Slot->SetSize(FVector2D(SizeX, SizeY));
	}
	WidgetBlueprint->MarkPackageDirty();
	return true;
}

TArray<FString> UClaudeBPGraphLibrary::ListWidgets(UWidgetBlueprint* WidgetBlueprint)
{
	TArray<FString> Out;
	if (!WidgetBlueprint || !WidgetBlueprint->WidgetTree)
	{
		return Out;
	}
	WidgetBlueprint->WidgetTree->ForEachWidget([&Out](UWidget* W)
	{
		if (!W)
		{
			return;
		}
		const FString ParentName = W->GetParent() ? W->GetParent()->GetName() : FString();
		Out.Add(FString::Printf(TEXT("%s|%s|%s"), *W->GetName(), *W->GetClass()->GetName(), *ParentName));
	});
	return Out;
}
