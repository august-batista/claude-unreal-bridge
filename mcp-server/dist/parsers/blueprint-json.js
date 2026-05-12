/**
 * Format a BlueprintInfo as human-readable markdown text.
 *
 * Detail levels:
 *   summary    — signatures and metadata, no graph bodies
 *   full       — everything: signatures + function bodies + event graphs
 *   graph-only — function bodies + event graphs, no vars/components/dispatchers
 */
export function formatBlueprintAsMarkdown(bp, detail = "full") {
    const lines = [];
    const showMetadata = detail !== "graph-only";
    const showBodies = detail !== "summary";
    const customEventNames = collectCustomEventNames(bp);
    lines.push(`# Blueprint: ${bp.className}`);
    lines.push(`**Asset Path:** \`${bp.assetPath}\``);
    lines.push(`**Parent Class:** ${bp.parentClass} (\`${bp.parentClassPath}\`)`);
    if (bp.interfaces.length > 0) {
        lines.push(`**Implements:** ${bp.interfaces.join(", ")}`);
    }
    if (showMetadata && bp.variables.length > 0) {
        lines.push("", "## Variables", "");
        for (const v of bp.variables) {
            const flags = [];
            if (v.isEditable)
                flags.push("Editable");
            if (v.isExposed)
                flags.push("Exposed");
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            const defaultStr = v.defaultValue !== undefined ? ` = ${v.defaultValue}` : "";
            const catStr = v.category ? ` (${v.category})` : "";
            lines.push(`- **${v.name}**: ${v.type}${defaultStr}${catStr}${flagStr}`);
            if (v.tooltip)
                lines.push(`  - ${v.tooltip}`);
        }
    }
    if (bp.functions.length > 0) {
        lines.push("", "## Functions", "");
        for (const f of bp.functions) {
            const purity = f.isPure ? "Pure " : "";
            const inputs = f.inputs.map((p) => `${p.name}: ${p.type}`).join(", ");
            const outputs = f.outputs.map((p) => `${p.name}: ${p.type}`).join(", ");
            const retStr = outputs ? ` -> (${outputs})` : "";
            lines.push("", `### ${purity}${f.name}(${inputs})${retStr}`);
            if (f.description)
                lines.push("", f.description);
            if (showBodies) {
                lines.push("");
                formatFunctionBody(f, lines, customEventNames);
            }
        }
    }
    if (showMetadata && bp.components.length > 0) {
        lines.push("", "## Components", "");
        formatComponentTree(bp.components, lines, 0);
    }
    if (showMetadata && bp.eventDispatchers.length > 0) {
        lines.push("", "## Event Dispatchers", "");
        for (const ed of bp.eventDispatchers) {
            const params = ed.params.map((p) => `${p.name}: ${p.type}`).join(", ");
            lines.push(`- **${ed.name}**(${params})`);
        }
    }
    if (showBodies) {
        for (const graph of bp.eventGraphs) {
            lines.push("", `## Event Graph: ${graph.name}`, "");
            formatEventGraph(graph, lines, customEventNames);
        }
    }
    return lines.join("\n");
}
function formatComponentTree(components, lines, indent) {
    const prefix = "  ".repeat(indent);
    for (const c of components) {
        const rootTag = c.isRoot ? " (Root)" : "";
        lines.push(`${prefix}- **${c.name}**: ${c.type}${rootTag}`);
        if (c.properties && Object.keys(c.properties).length > 0) {
            for (const [key, val] of Object.entries(c.properties)) {
                lines.push(`${prefix}  - ${key}: ${val}`);
            }
        }
        if (c.children && c.children.length > 0) {
            formatComponentTree(c.children, lines, indent + 1);
        }
    }
}
function collectCustomEventNames(bp) {
    const names = new Set();
    for (const g of bp.eventGraphs) {
        for (const n of g.nodes) {
            if (n.type === "K2Node_CustomEvent") {
                const m = n.title.match(/^Custom Event:\s*(.+)$/);
                if (m)
                    names.add(m[1].trim());
            }
        }
    }
    return names;
}
function buildPinLookup(nodes) {
    const lookup = new Map();
    for (const node of nodes) {
        for (const pin of node.pins) {
            if (pin.pinId)
                lookup.set(pin.pinId, { node, pin });
        }
    }
    return lookup;
}
function formatEventGraph(graph, lines, customEventNames) {
    if (graph.nodes.length === 0) {
        lines.push("*(empty graph)*");
        return;
    }
    const entryNodes = graph.nodes.filter((n) => n.type === "K2Node_Event" ||
        n.type === "K2Node_CustomEvent" ||
        n.type === "K2Node_EnhancedInputAction" ||
        n.type.includes("InputAction"));
    if (entryNodes.length === 0) {
        lines.push("**Nodes:**");
        for (const node of graph.nodes) {
            lines.push(`- ${formatNode(node)}`);
        }
        return;
    }
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const pinLookup = buildPinLookup(graph.nodes);
    for (const entry of entryNodes) {
        lines.push(`### ${entry.title}`, "");
        lines.push("```");
        traceExecutionFlow(entry, nodeMap, pinLookup, lines, 0, new Set(), customEventNames);
        lines.push("```", "");
    }
}
function formatFunctionBody(fn, lines, customEventNames) {
    if (fn.nodes.length === 0) {
        lines.push("*(empty function body)*");
        return;
    }
    const entryNode = fn.nodes.find((n) => n.type === "K2Node_FunctionEntry");
    if (!entryNode) {
        lines.push("**Nodes:**");
        for (const node of fn.nodes) {
            lines.push(`- ${formatNode(node)}`);
        }
        return;
    }
    const nodeMap = new Map(fn.nodes.map((n) => [n.id, n]));
    const pinLookup = buildPinLookup(fn.nodes);
    const execOut = entryNode.pins.find((p) => p.direction === "output" && p.type === "exec" && p.connectedTo.length > 0);
    lines.push("```");
    if (execOut) {
        const nextId = extractNodeId(execOut.connectedTo[0]);
        const next = nodeMap.get(nextId);
        if (next) {
            traceExecutionFlow(next, nodeMap, pinLookup, lines, 0, new Set(), customEventNames);
        }
    }
    else {
        lines.push("(empty body)");
    }
    lines.push("```");
}
function traceExecutionFlow(node, nodeMap, pinLookup, lines, indent, visited, customEventNames) {
    if (visited.has(node.id)) {
        lines.push(`${"  ".repeat(indent)}-> (back to ${node.title})`);
        return;
    }
    visited.add(node.id);
    const prefix = "  ".repeat(indent);
    lines.push(`${prefix}${describeNode(node, customEventNames, nodeMap, pinLookup)}`);
    const execOutputs = node.pins.filter((p) => p.direction === "output" && p.type === "exec" && p.connectedTo.length > 0);
    if (execOutputs.length === 1) {
        const nextNodeId = extractNodeId(execOutputs[0].connectedTo[0]);
        const nextNode = nodeMap.get(nextNodeId);
        if (nextNode) {
            traceExecutionFlow(nextNode, nodeMap, pinLookup, lines, indent, visited, customEventNames);
        }
    }
    else if (execOutputs.length > 1) {
        for (const pin of execOutputs) {
            const branchLabel = pin.name === "then" ? "" : `[${pin.name}]`;
            if (pin.connectedTo.length > 0) {
                const nextNodeId = extractNodeId(pin.connectedTo[0]);
                const nextNode = nodeMap.get(nextNodeId);
                if (nextNode) {
                    if (branchLabel)
                        lines.push(`${prefix}${branchLabel}:`);
                    traceExecutionFlow(nextNode, nodeMap, pinLookup, lines, indent + 1, visited, customEventNames);
                }
            }
        }
    }
}
/**
 * Walk a data wire back through any reroute (knot) nodes to find the real
 * upstream source. Returns the source node and pin name, or null if the
 * chain dead-ends.
 */
function resolveDataSource(ref, nodeMap, pinLookup, visited = new Set()) {
    if (visited.has(ref))
        return null;
    visited.add(ref);
    const { nodeId, pinId } = parseConnRef(ref);
    const node = nodeMap.get(nodeId);
    if (!node)
        return null;
    if (node.type === "K2Node_Knot") {
        const input = node.pins.find((p) => p.direction === "input");
        if (!input || input.connectedTo.length === 0)
            return null;
        return resolveDataSource(input.connectedTo[0], nodeMap, pinLookup, visited);
    }
    let pinName;
    if (pinId) {
        const hit = pinLookup.get(pinId);
        if (hit)
            pinName = hit.pin.name;
    }
    return { node, pinName };
}
function describeNode(node, customEventNames, nodeMap, pinLookup) {
    const dataInputs = node.pins.filter((p) => p.direction === "input" && p.type !== "exec");
    const argStr = dataInputs
        .map((p) => {
        if (p.connectedTo.length > 0) {
            const src = resolveDataSource(p.connectedTo[0], nodeMap, pinLookup);
            if (src) {
                const srcLabel = src.pinName
                    ? `${src.node.title}.${src.pinName}`
                    : src.node.title;
                return `${p.name}=<from ${srcLabel}>`;
            }
            return `${p.name}=<connected>`;
        }
        if (p.defaultValue)
            return `${p.name}=${p.defaultValue}`;
        return null;
    })
        .filter(Boolean)
        .join(", ");
    if (node.type === "K2Node_Event" || node.type === "K2Node_CustomEvent" ||
        node.type.includes("InputAction")) {
        return `on ${node.title}:`;
    }
    if (node.type === "K2Node_FunctionResult") {
        return argStr ? `return (${argStr})` : "return";
    }
    if (node.type === "K2Node_IfThenElse" || node.type.includes("Branch")) {
        return `if (${argStr || "condition"}):`;
    }
    if (node.type.includes("ForEach") || node.type.includes("ForLoop")) {
        return `for ${argStr || "each item"}:`;
    }
    if (node.type === "K2Node_ExecutionSequence") {
        return `sequence:`;
    }
    if (node.type === "K2Node_CallFunction" && node.function) {
        const tag = customEventNames.has(node.function) ? " [custom event]" : "";
        return argStr ? `${node.function}(${argStr})${tag}` : `${node.function}()${tag}`;
    }
    if (node.function) {
        return argStr ? `${node.function}(${argStr})` : `${node.function}()`;
    }
    if (node.type === "K2Node_VariableSet") {
        return `Set ${node.title}${argStr ? ` = ${argStr}` : ""}`;
    }
    if (node.type === "K2Node_VariableGet") {
        return `Get ${node.title}`;
    }
    return argStr ? `${node.title}(${argStr})` : node.title;
}
function formatNode(node) {
    return `[${node.type}] ${node.title}${node.function ? ` -> ${node.function}` : ""}`;
}
function extractNodeId(connectionRef) {
    return parseConnRef(connectionRef).nodeId;
}
function parseConnRef(ref) {
    const hashIdx = ref.indexOf("#");
    if (hashIdx >= 0) {
        return { nodeId: ref.substring(0, hashIdx), pinId: ref.substring(hashIdx + 1) };
    }
    const dotIdx = ref.indexOf(".");
    return { nodeId: dotIdx >= 0 ? ref.substring(0, dotIdx) : ref };
}
/**
 * Validate that the JSON data looks like a valid BlueprintInfo.
 */
export function validateBlueprintJson(data) {
    if (!data || typeof data !== "object")
        return false;
    const obj = data;
    return (typeof obj.assetPath === "string" &&
        typeof obj.className === "string" &&
        typeof obj.parentClass === "string" &&
        Array.isArray(obj.variables) &&
        Array.isArray(obj.functions) &&
        Array.isArray(obj.eventGraphs));
}
//# sourceMappingURL=blueprint-json.js.map