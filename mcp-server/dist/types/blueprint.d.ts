export interface BlueprintPin {
    name: string;
    direction: "input" | "output";
    type: string;
    subtype?: string;
    defaultValue?: string;
    connectedTo: string[];
}
export interface BlueprintNode {
    id: string;
    type: string;
    title: string;
    function?: string;
    pins: BlueprintPin[];
    comment?: string;
    position?: {
        x: number;
        y: number;
    };
}
export interface BlueprintGraph {
    name: string;
    nodes: BlueprintNode[];
}
export interface BlueprintVariable {
    name: string;
    type: string;
    defaultValue?: string;
    category?: string;
    isEditable: boolean;
    isExposed: boolean;
    tooltip?: string;
}
export interface FunctionParam {
    name: string;
    type: string;
}
export interface BlueprintFunction {
    name: string;
    inputs: FunctionParam[];
    outputs: FunctionParam[];
    isPure: boolean;
    isStatic: boolean;
    accessSpecifier: "public" | "protected" | "private";
    description?: string;
    nodes: BlueprintNode[];
}
export interface BlueprintComponent {
    name: string;
    type: string;
    isRoot: boolean;
    children?: BlueprintComponent[];
    properties?: Record<string, string>;
}
export interface EventDispatcher {
    name: string;
    params: FunctionParam[];
}
export interface BlueprintInfo {
    assetPath: string;
    className: string;
    parentClass: string;
    parentClassPath: string;
    variables: BlueprintVariable[];
    functions: BlueprintFunction[];
    eventGraphs: BlueprintGraph[];
    components: BlueprintComponent[];
    interfaces: string[];
    eventDispatchers: EventDispatcher[];
}
export interface BlueprintListEntry {
    assetPath: string;
    className: string;
    parentClass: string;
    type: "Blueprint" | "WidgetBlueprint" | "AnimBlueprint" | "Other";
}
export interface BlueprintSearchResult {
    assetPath: string;
    className: string;
    matches: {
        type: "node" | "variable" | "function" | "comment";
        name: string;
        context: string;
    }[];
}
export interface ClassHierarchyNode {
    className: string;
    assetPath?: string;
    children: ClassHierarchyNode[];
}
//# sourceMappingURL=blueprint.d.ts.map