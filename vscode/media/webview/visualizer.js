"use strict";
(() => {
  // src/visualization/prepareData.ts
  function graphToElementTree(graph) {
    if (!graph?.nodes?.length) return [];
    const nodes = graph.nodes;
    const edges = graph.edges || [];
    const nodeMap = /* @__PURE__ */ new Map();
    nodes.forEach((n) => {
      nodeMap.set(n.id, {
        id: n.id,
        name: n.name,
        type: n.type,
        range: n.range,
        attributes: n.attributes || {},
        relationships: [],
        children: []
      });
    });
    const getEdgeType = (e) => (e.type || e.rel_type || "").toLowerCase();
    edges.forEach((e) => {
      if (getEdgeType(e) === "contains" && e.source && e.target) {
        const parent = nodeMap.get(e.source);
        const child = nodeMap.get(e.target);
        if (parent && child) {
          parent.children.push(child);
        }
      }
      const relTypes = ["typing", "specializes", "connection", "bind", "allocate", "transition", "satisfy", "verify"];
      if (relTypes.includes(getEdgeType(e))) {
        const src = nodeMap.get(e.source);
        if (src) {
          src.relationships.push({ source: e.source, target: e.target, type: e.type, name: e.name });
        }
      }
    });
    const targetsOfContains = new Set(edges.filter((e) => getEdgeType(e) === "contains").map((e) => e.target));
    const roots = nodes.filter((n) => !targetsOfContains.has(n.id)).map((n) => nodeMap.get(n.id)).filter(Boolean);
    return roots;
  }
  function prepareDataForView(data, view) {
    if (!data) {
      return data;
    }
    const hasGraph = data.graph?.nodes;
    const elements = hasGraph ? graphToElementTree(data.graph) : data.elements || [];
    const edgeType = (e) => e.type || e.rel_type || "";
    const relationships = hasGraph ? (data.graph.edges || []).filter((e) => edgeType(e) !== "contains").map((e) => ({
      source: e.source,
      target: e.target,
      type: edgeType(e),
      name: e.name
    })) : data.relationships || [];
    function collectAllElements(elementList, collected = [], parentElement = null) {
      elementList.forEach((el) => {
        if (parentElement && !el.parent) {
          el.parent = parentElement.name;
        }
        collected.push(el);
        if (el.children && el.children.length > 0) {
          collectAllElements(el.children, collected, el);
        }
      });
      return collected;
    }
    function removeCircularRefs(obj) {
      if (!obj || typeof obj !== "object") return obj;
      if (obj.parentElement) {
        delete obj.parentElement;
      }
      if (obj.children && Array.isArray(obj.children)) {
        obj.children.forEach((child) => removeCircularRefs(child));
      }
      return obj;
    }
    const allElements = collectAllElements(elements);
    switch (view) {
      case "general-view":
        return data;
      case "interconnection-view": {
        if (data.ibd && Array.isArray(data.ibd.parts)) {
          const ibd = data.ibd;
          const selectedRoot = data.selectedIbdRoot && typeof data.selectedIbdRoot === "string" ? data.selectedIbdRoot : ibd.defaultRoot ?? ibd.rootCandidates?.[0] ?? null;
          const rootPart = selectedRoot ? ibd.parts.find((p) => p.name === selectedRoot) : null;
          const rootPrefix = rootPart ? rootPart.qualifiedName || rootPart.name : selectedRoot || "";
          const focusedParts = rootPrefix ? ibd.parts.filter((p) => {
            const q = p.qualifiedName || p.name;
            return q === rootPrefix || rootPrefix && q.startsWith(rootPrefix + ".");
          }) : [];
          const partIds = new Set(focusedParts.map((p) => p.qualifiedName || p.name));
          const partNames = new Set(focusedParts.map((p) => p.name));
          const focusedPorts = ibd.ports.filter(
            (p) => partIds.has(p.parentId) || partNames.has(p.parentId)
          );
          const focusedConnectors = ibd.connectors.filter((c) => {
            const srcMatch = focusedParts.some((p) => {
              const q = p.qualifiedName || p.name;
              return c.sourceId === q || c.sourceId.startsWith(q + ".") || c.sourceId === p.name;
            });
            const tgtMatch = focusedParts.some((p) => {
              const q = p.qualifiedName || p.name;
              return c.targetId === q || c.targetId.startsWith(q + ".") || c.targetId === p.name;
            });
            return srcMatch && tgtMatch;
          });
          return {
            ...data,
            elements: focusedParts,
            parts: focusedParts,
            ports: focusedPorts,
            connectors: focusedConnectors,
            ibdRootCandidates: ibd.rootCandidates || [],
            selectedIbdRoot: selectedRoot
          };
        }
        return {
          ...data,
          elements: [],
          parts: [],
          ports: [],
          connectors: [],
          ibdRootCandidates: [],
          selectedIbdRoot: null
        };
      }
      case "action-flow-view": {
        if (data.activityDiagrams && data.activityDiagrams.length > 0) {
          return {
            ...data,
            diagrams: data.activityDiagrams.map((diagram) => {
              const decisionsAsActions = (diagram.decisions || []).map((d) => ({
                ...d,
                id: d.id || d.name,
                type: "decision",
                kind: "decision"
              }));
              const allActions = [
                ...(diagram.actions || []).map((a) => ({
                  ...a,
                  id: a.id || a.name,
                  parent: a.parent === diagram.name ? void 0 : a.parent
                })),
                ...decisionsAsActions
              ];
              const actionIds = new Set(allActions.map((a) => a.id || a.name));
              const flows = diagram.flows || [];
              const flowNodeNames = /* @__PURE__ */ new Set();
              const incomingFlowCount = /* @__PURE__ */ new Map();
              const outgoingFlowCount = /* @__PURE__ */ new Map();
              flows.forEach((f) => {
                if (f.from) {
                  flowNodeNames.add(f.from);
                  outgoingFlowCount.set(f.from, (outgoingFlowCount.get(f.from) || 0) + 1);
                }
                if (f.to) {
                  flowNodeNames.add(f.to);
                  incomingFlowCount.set(f.to, (incomingFlowCount.get(f.to) || 0) + 1);
                }
              });
              flowNodeNames.forEach((nodeName) => {
                if (!actionIds.has(nodeName)) {
                  const incoming = incomingFlowCount.get(nodeName) || 0;
                  const outgoing = outgoingFlowCount.get(nodeName) || 0;
                  const nameLower = nodeName.toLowerCase();
                  let nodeType = "action";
                  let nodeKind = "action";
                  if (nameLower.includes("merge") || nameLower.includes("join") || nameLower.endsWith("check")) {
                    nodeType = "merge";
                    nodeKind = "merge";
                  } else if (nameLower.includes("fork")) {
                    nodeType = "fork";
                    nodeKind = "fork";
                  } else if (nameLower.includes("decision") || nameLower.includes("decide")) {
                    nodeType = "decision";
                    nodeKind = "decision";
                  } else if (incoming > 1) {
                    nodeType = "merge";
                    nodeKind = "merge";
                  } else if (outgoing > 1) {
                    const hasGuards = flows.some((f) => f.from === nodeName && (f.guard || f.condition));
                    if (hasGuards) {
                      nodeType = "decision";
                      nodeKind = "decision";
                    } else {
                      nodeType = "fork";
                      nodeKind = "fork";
                    }
                  }
                  allActions.push({
                    name: nodeName,
                    id: nodeName,
                    type: nodeType,
                    kind: nodeKind
                  });
                  actionIds.add(nodeName);
                }
              });
              const cleanFlows = flows.filter(
                (f) => f.from !== f.to && actionIds.has(f.from) && actionIds.has(f.to)
              );
              return {
                name: diagram.name,
                actions: allActions,
                flows: cleanFlows,
                decisions: diagram.decisions || [],
                states: diagram.states || []
              };
            })
          };
        }
        const actionDefs = allElements.filter((el) => {
          if (!el.type) return false;
          const typeLower = el.type.toLowerCase();
          return typeLower === "action" || typeLower === "action def" || typeLower === "action definition";
        });
        const activityActionDefs = actionDefs.filter((a) => a.children && a.children.length > 0);
        return {
          ...data,
          diagrams: activityActionDefs.map((actionDef) => {
            const childActions = actionDef.children.filter((c) => c.type && c.type.toLowerCase().includes("action")).map((c) => ({
              name: c.name,
              type: "action",
              kind: "action",
              id: c.name
            }));
            const flows = [];
            for (let i = 0; i < childActions.length - 1; i++) {
              flows.push({ from: childActions[i].name, to: childActions[i + 1].name });
            }
            if (childActions.length > 0) {
              flows.unshift({ from: "start", to: childActions[0].name });
              flows.push({ from: childActions[childActions.length - 1].name, to: "done" });
              childActions.unshift({ name: "start", type: "initial", kind: "initial", id: "start" });
              childActions.push({ name: "done", type: "final", kind: "final", id: "done" });
            }
            return {
              name: actionDef.name,
              actions: childActions,
              flows,
              decisions: [],
              states: []
            };
          })
        };
      }
      case "state-transition-view": {
        const stateElements = allElements.filter((el) => el.type && (el.type.includes("state") || el.type.includes("State")));
        return {
          ...data,
          states: stateElements,
          transitions: relationships.filter(
            (rel) => rel.type && rel.type.includes("transition")
          )
        };
      }
      case "sequence-view": {
        let collectParticipants2 = function(el) {
          const parts = [];
          function walk(children) {
            for (const c of children) {
              if (!c.type) continue;
              const t = c.type.toLowerCase();
              if (t === "actor" || t === "actor usage" || t === "actor def") {
                if (!parts.find((p) => p.name === c.name)) {
                  parts.push({ name: c.name, type: "actor" });
                }
              } else if (t === "part" || t === "part usage" || t === "part def" || t === "item" || t === "item usage" || t === "item def") {
                if (!parts.find((p) => p.name === c.name)) {
                  parts.push({ name: c.name, type: c.typing || "component" });
                }
              } else if (t === "port" || t === "port usage") {
                if (!parts.find((p) => p.name === c.name)) {
                  parts.push({ name: c.name, type: "port" });
                }
              }
              if (c.children && c.children.length > 0) walk(c.children);
            }
          }
          walk(el.children || []);
          if (parts.length === 0) parts.push({ name: "system", type: "system" });
          return parts;
        }, buildMessages2 = function(el, participants) {
          const msgs = [];
          let occ = 1;
          function walk(children) {
            for (const c of children) {
              if (!c.type) continue;
              const t = c.type.toLowerCase();
              if (t === "action" || t === "action usage" || t === "action def") {
                const cName = (c.name || "").toLowerCase();
                let from = participants[0]?.name || "system";
                let to = participants.length > 1 ? participants[1].name : participants[0]?.name || "system";
                for (const p of participants) {
                  const pLower = p.name.toLowerCase();
                  if (cName.includes(pLower) || pLower.includes(cName)) {
                    to = p.name;
                    break;
                  }
                }
                const actorP = participants.find((p) => p.type === "actor");
                if (actorP) from = actorP.name;
                msgs.push({ name: c.name, from, to, payload: c.name, occurrence: occ++ });
                if (c.children && c.children.length > 0) walk(c.children);
              }
            }
          }
          walk(el.children || []);
          return msgs;
        };
        var collectParticipants = collectParticipants2, buildMessages = buildMessages2;
        if (data.sequenceDiagrams && data.sequenceDiagrams.length > 0) {
          return { ...data, sequenceDiagrams: data.sequenceDiagrams };
        }
        const seqCandidates = allElements.filter((el) => {
          if (!el.type || !el.children || el.children.length === 0) return false;
          const nameLower = (el.name || "").toLowerCase();
          const typeLower = el.type.toLowerCase();
          const hasSequenceName = /sequence|interaction|workflow|scenario|process/.test(nameLower);
          const isInteraction = typeLower.includes("interaction");
          if (!hasSequenceName && !isInteraction) return false;
          const hasParts = el.children.some((c) => c.type && c.type.toLowerCase().includes("part"));
          return hasParts;
        });
        const actionSeqCandidates = allElements.filter((el) => {
          if (!el.type || !el.children || el.children.length === 0) return false;
          const typeLower = el.type.toLowerCase();
          const isAction = typeLower === "action def" || typeLower === "action definition" || typeLower === "action" || typeLower === "action usage";
          if (!isAction) return false;
          const hasChildActions = el.children.some((c) => {
            if (!c.type) return false;
            const ct = c.type.toLowerCase();
            return ct === "action" || ct === "action usage" || ct === "action def";
          });
          return hasChildActions;
        });
        const allCandidatesMap = /* @__PURE__ */ new Map();
        for (const c of seqCandidates) allCandidatesMap.set(c.name, c);
        for (const c of actionSeqCandidates) {
          if (!allCandidatesMap.has(c.name)) allCandidatesMap.set(c.name, c);
        }
        const allSeqCandidates = Array.from(allCandidatesMap.values());
        if (allSeqCandidates.length > 0) {
          const synthesisedDiagrams = allSeqCandidates.map((candidate) => {
            const participants = collectParticipants2(candidate);
            const messages = buildMessages2(candidate, participants);
            return { name: candidate.name, participants, messages };
          });
          return { ...data, sequenceDiagrams: synthesisedDiagrams };
        }
        return { ...data, sequenceDiagrams: [] };
      }
      default:
        return data;
    }
  }

  // src/visualization/webview/constants.ts
  var MIN_CANVAS_ZOOM = 0.04;
  var MAX_CANVAS_ZOOM = 5;
  var MIN_SYSML_ZOOM = 0.04;
  var MAX_SYSML_ZOOM = 5;
  var STRUCTURAL_VIEWS = /* @__PURE__ */ new Set(["general-view"]);
  var ORIENTATION_LABELS = {
    horizontal: "Horizontal",
    linear: "Linear (Top-Down)"
  };
  var VIEW_OPTIONS = {
    "general-view": { label: "General View" },
    "interconnection-view": { label: "Interconnection View" }
    // Disabled for next release: action-flow-view, state-transition-view, sequence-view
  };
  var GENERAL_VIEW_PALETTE = {
    structural: {
      part: "#2D8A6E",
      port: "#0E7C7B",
      attribute: "#4A9B7F",
      item: "#5A9B6E",
      interface: "#7BAA7D"
    },
    behavior: {
      action: "#D4A02C",
      state: "#B85C38",
      calc: "#C9A227"
    },
    requirements: {
      requirement: "#5B8FC4",
      useCase: "#6B9BD1"
    },
    other: {
      allocation: "#9CA3AF",
      constraint: "#E07C5A",
      default: "var(--vscode-panel-border)"
    }
  };
  var GENERAL_VIEW_TYPE_COLORS = {
    "part def": GENERAL_VIEW_PALETTE.structural.part,
    part: GENERAL_VIEW_PALETTE.structural.part,
    "port def": GENERAL_VIEW_PALETTE.structural.port,
    port: GENERAL_VIEW_PALETTE.structural.port,
    "attribute def": GENERAL_VIEW_PALETTE.structural.attribute,
    attribute: GENERAL_VIEW_PALETTE.structural.attribute,
    "action def": GENERAL_VIEW_PALETTE.behavior.action,
    action: GENERAL_VIEW_PALETTE.behavior.action,
    "state def": GENERAL_VIEW_PALETTE.behavior.state,
    state: GENERAL_VIEW_PALETTE.behavior.state,
    "interface def": GENERAL_VIEW_PALETTE.structural.interface,
    interface: GENERAL_VIEW_PALETTE.structural.interface,
    "requirement def": GENERAL_VIEW_PALETTE.requirements.requirement,
    requirement: GENERAL_VIEW_PALETTE.requirements.requirement,
    "use case def": GENERAL_VIEW_PALETTE.requirements.useCase,
    "use case": GENERAL_VIEW_PALETTE.requirements.useCase,
    verification: GENERAL_VIEW_PALETTE.behavior.calc,
    analysis: GENERAL_VIEW_PALETTE.behavior.action,
    allocation: GENERAL_VIEW_PALETTE.other.allocation,
    "allocation def": GENERAL_VIEW_PALETTE.other.allocation,
    "item def": GENERAL_VIEW_PALETTE.structural.item,
    item: GENERAL_VIEW_PALETTE.structural.item,
    "calc def": GENERAL_VIEW_PALETTE.behavior.calc,
    calc: GENERAL_VIEW_PALETTE.behavior.calc,
    "constraint def": GENERAL_VIEW_PALETTE.other.constraint,
    constraint: GENERAL_VIEW_PALETTE.other.constraint,
    "enumeration def": GENERAL_VIEW_PALETTE.behavior.calc,
    enumeration: GENERAL_VIEW_PALETTE.behavior.calc,
    "metadata def": "#8B7355",
    metadata: "#8B7355",
    "occurrence def": GENERAL_VIEW_PALETTE.structural.item,
    occurrence: GENERAL_VIEW_PALETTE.structural.item,
    package: "#6B7280",
    default: GENERAL_VIEW_PALETTE.other.default
  };

  // src/visualization/webview/shared.ts
  var DANGEROUS_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
  function normalizeAttributes(attributes) {
    const properties = {};
    if (!attributes) {
      return properties;
    }
    if (typeof attributes.forEach === "function") {
      attributes.forEach((value, key) => {
        if (!DANGEROUS_KEYS.has(key)) {
          properties[key] = value;
        }
      });
    } else {
      for (const key of Object.keys(attributes)) {
        if (!DANGEROUS_KEYS.has(key)) {
          properties[key] = attributes[key];
        }
      }
    }
    return properties;
  }
  function getElementProperties(element) {
    if (element?.properties) {
      return element.properties;
    }
    return normalizeAttributes(element?.attributes);
  }
  function formatStereotype(type) {
    if (!type) {
      return "";
    }
    return "<<" + String(type).trim() + ">>";
  }
  function formatSysMLStereotype(type) {
    if (!type) {
      return "";
    }
    const normalized = normalizeTypeForDisplay(type);
    return normalized ? "\xAB" + normalized + "\xBB" : "";
  }
  function normalizeTypeForDisplay(type) {
    if (!type) {
      return "";
    }
    const normalized = String(type).trim().toLowerCase();
    if (!normalized) {
      return "";
    }
    if (normalized.endsWith(" definition")) {
      const stripped = normalized.slice(0, -11).trim() + " def";
      if (stripped.length > 0) return stripped;
    }
    return normalized;
  }
  function buildElementDisplayLabel(element) {
    if (!element) {
      return "";
    }
    const normalizedType = normalizeTypeForDisplay(element.type);
    const stereotype = normalizedType ? formatStereotype(normalizedType) : "";
    const displayName = element.name || "Unnamed";
    return stereotype ? stereotype + " " + displayName : displayName;
  }
  function isLibraryValidated(element) {
    if (!element?.attributes) {
      return false;
    }
    const attrs = element.attributes;
    if (typeof attrs.get === "function") {
      return attrs.get("isStandardType") === true || attrs.get("isStandardElement") === true;
    }
    return attrs.isStandardType === true || attrs.isStandardElement === true;
  }
  function getTypeColor(type) {
    const t = (type || "").toLowerCase();
    if (GENERAL_VIEW_TYPE_COLORS[t]) return GENERAL_VIEW_TYPE_COLORS[t];
    for (const key of Object.keys(GENERAL_VIEW_TYPE_COLORS)) {
      if (key !== "default" && t.includes(key)) return GENERAL_VIEW_TYPE_COLORS[key];
    }
    return GENERAL_VIEW_TYPE_COLORS["default"];
  }
  function isActorElement(elementOrType) {
    const typeValue = typeof elementOrType === "string" ? elementOrType : elementOrType?.type;
    if (!typeValue) {
      return false;
    }
    return String(typeValue).toLowerCase().includes("actor");
  }
  function renderActorGlyph(container, clickHandler, dblClickHandler) {
    const actorGroup = container.append("g").attr("class", "actor-icon").attr("transform", "translate(0,-4)");
    actorGroup.append("circle").attr("cx", 0).attr("cy", -6).attr("r", 6).style("fill", "none").style("stroke", "var(--vscode-charts-blue)").style("stroke-width", 2);
    actorGroup.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 18).style("stroke", "var(--vscode-charts-blue)").style("stroke-width", 2);
    actorGroup.append("line").attr("x1", -10).attr("y1", 4).attr("x2", 10).attr("y2", 4).style("stroke", "var(--vscode-charts-blue)").style("stroke-width", 2);
    actorGroup.append("line").attr("x1", 0).attr("y1", 18).attr("x2", -10).attr("y2", 32).style("stroke", "var(--vscode-charts-blue)").style("stroke-width", 2);
    actorGroup.append("line").attr("x1", 0).attr("y1", 18).attr("x2", 10).attr("y2", 32).style("stroke", "var(--vscode-charts-blue)").style("stroke-width", 2);
    if (clickHandler) {
      actorGroup.on("click", clickHandler);
    }
    if (dblClickHandler) {
      actorGroup.on("dblclick", dblClickHandler);
    }
    return actorGroup;
  }
  function quickHash(obj) {
    const str = JSON.stringify(obj);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  // src/visualization/webview/helpers.ts
  function isMetadataElement(type) {
    return type === "doc" || type === "comment" || type === "metadata" || type === "metadata def";
  }
  function extractDocumentation(element) {
    if (!element) return null;
    if (element.children) {
      const docElements = element.children.filter((child) => isMetadataElement(child.type));
      if (docElements.length > 0) {
        return docElements.map((doc) => doc.name || "Documentation").join(" ");
      }
    }
    if (isMetadataElement(element.type)) {
      return element.name || "Documentation";
    }
    return null;
  }
  function flattenElements(elements, result = []) {
    (elements || []).forEach((el) => {
      if (isMetadataElement(el.type)) return;
      const properties = normalizeAttributes(el.attributes);
      const documentation = extractDocumentation(el);
      if (documentation) {
        properties["documentation"] = documentation;
      }
      result.push({
        name: el.name,
        type: el.type,
        properties,
        pillar: el.pillar,
        element: el
      });
      if (el.children && el.children.length > 0) {
        flattenElements(el.children, result);
      }
    });
    return result;
  }
  function createLinksFromHierarchy(elements, parent = null, links = []) {
    (elements || []).forEach((el) => {
      if (parent) {
        links.push({ source: parent.name, target: el.name });
      }
      if (el.children && el.children.length > 0) {
        createLinksFromHierarchy(el.children, el, links);
      }
    });
    return links;
  }
  function buildEnhancedElementLabel(element) {
    if (!element) return "";
    const baseLabel = buildElementDisplayLabel(element);
    const lines = [baseLabel];
    if (element.children && element.children.length > 0) {
      const attributes = [];
      const ports = [];
      element.children.forEach((child) => {
        if (!child || !child.type) return;
        const typeLower = child.type.toLowerCase();
        if (typeLower === "attribute" || typeLower.includes("attribute")) {
          const attrName = child.name || "unnamed";
          const attrType = child.typing || "";
          attributes.push(attrType ? attrName + ": " + attrType : attrName);
        } else if (typeLower.includes("port")) {
          const portName = child.name || "unnamed";
          const portType = child.typing || "";
          const direction = typeLower.includes("in") ? "\u2192" : typeLower.includes("out") ? "\u2190" : "\u2194";
          ports.push(direction + " " + portName + (portType ? ": " + portType : ""));
        }
      });
      if (attributes.length > 0) {
        const shown = attributes.slice(0, 3);
        lines.push("", "Attributes:");
        shown.forEach((a) => lines.push("  \u2022 " + a));
        if (attributes.length > 3) {
          lines.push("  +" + (attributes.length - 3) + " more");
        }
      }
      if (ports.length > 0) {
        lines.push("", "Ports:");
        const shown = ports.slice(0, 3);
        shown.forEach((p) => lines.push("  " + p));
        if (ports.length > 3) {
          lines.push("  +" + (ports.length - 3) + " more");
        }
      }
    }
    return lines.join("\n");
  }
  function getLibraryChain(element) {
    if (!element || !element.attributes) return null;
    const attrs = element.attributes;
    if (typeof attrs.get === "function") {
      return attrs.get("specializationChain");
    }
    return attrs.specializationChain;
  }
  function getLibraryKind(element) {
    if (!element || !element.attributes) return null;
    const attrs = element.attributes;
    if (typeof attrs.get === "function") {
      return attrs.get("libraryKind");
    }
    return attrs.libraryKind;
  }
  function slugify(value) {
    if (!value) return "unknown";
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  // src/visualization/webview/renderers/sequence.ts
  function renderSequenceView(ctx, data) {
    const { width, height, g: g2, postMessage, onStartInlineEdit } = ctx;
    if (!data || !data.sequenceDiagrams || data.sequenceDiagrams.length === 0) {
      const messageGroup = g2.append("g").attr("class", "sequence-message");
      messageGroup.append("text").attr("x", width / 2).attr("y", height / 2).attr("text-anchor", "middle").text("No sequence diagrams found in this SysML model").style("font-size", "18px").style("fill", "var(--vscode-descriptionForeground)").style("font-weight", "bold");
      messageGroup.append("text").attr("x", width / 2).attr("y", height / 2 + 30).attr("text-anchor", "middle").text('Add "interaction def" elements to see sequence diagrams').style("font-size", "14px").style("fill", "var(--vscode-descriptionForeground)");
      return;
    }
    const diagrams = data.sequenceDiagrams;
    let currentY = 50;
    diagrams.forEach((diagram) => {
      const diagramGroup = g2.append("g").attr("class", "sequence-diagram").attr("transform", "translate(0, " + currentY + ")");
      diagramGroup.append("text").attr("x", width / 2).attr("y", 0).attr("text-anchor", "middle").text(diagram.name).style("font-size", "20px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)").on("click", () => {
        postMessage({ command: "jumpToElement", elementName: diagram.name });
      }).style("cursor", "pointer");
      const participants = diagram.participants;
      const messages = diagram.messages;
      const participantWidth = Math.min(150, (width - 100) / participants.length);
      const participantSpacing = (width - 100) / Math.max(1, participants.length - 1);
      const messageHeight = 80;
      const diagramHeight = Math.max(400, messages.length * messageHeight + 200);
      participants.forEach((participant, i) => {
        const participantX = 50 + i * participantSpacing;
        const isLibValidated = participant.element ? isLibraryValidated(participant.element) : false;
        const borderColor = isLibValidated ? "var(--vscode-charts-green)" : "var(--vscode-panel-border)";
        const borderWidth = isLibValidated ? "3px" : "2px";
        const participantGroup = diagramGroup.append("g").attr("class", "sequence-participant").attr("transform", "translate(" + participantX + ", 40)").style("cursor", "pointer");
        if (isActorElement(participant)) {
          const actorContainer = participantGroup.append("g").attr("transform", "translate(0, 0)");
          renderActorGlyph(actorContainer);
          participantGroup.append("text").attr("class", "node-name-text").attr("data-element-name", participant.name).attr("x", 0).attr("y", 45).attr("text-anchor", "middle").text(participant.name).style("font-size", "14px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)");
          participantGroup.append("text").attr("x", 0).attr("y", 62).attr("text-anchor", "middle").text("[" + participant.type + "]").style("font-size", "11px").style("fill", "var(--vscode-descriptionForeground)");
        } else {
          participantGroup.append("rect").attr("x", -participantWidth / 2).attr("y", 0).attr("width", participantWidth).attr("height", 60).attr("rx", 8).style("fill", "var(--vscode-editor-background)").style("stroke", borderColor).style("stroke-width", borderWidth);
          participantGroup.append("text").attr("class", "node-name-text").attr("data-element-name", participant.name).attr("x", 0).attr("y", 25).attr("text-anchor", "middle").text(participant.name).style("font-size", "14px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)");
          participantGroup.append("text").attr("x", 0).attr("y", 42).attr("text-anchor", "middle").text("[" + participant.type + "]").style("font-size", "11px").style("fill", "var(--vscode-descriptionForeground)");
        }
        participantGroup.on("click", function(event) {
          event.stopPropagation();
          postMessage({ command: "jumpToElement", elementName: participant.name });
        }).on("dblclick", function(event) {
          event.stopPropagation();
          onStartInlineEdit(
            d3.select(this),
            participant.name,
            participantX - participantWidth / 2,
            40,
            participantWidth
          );
        });
        const lifelineY = isActorElement(participant) ? 70 : 60;
        participantGroup.append("line").attr("x1", 0).attr("y1", lifelineY).attr("x2", 0).attr("y2", diagramHeight - 60).style("stroke", "var(--vscode-panel-border)").style("stroke-width", "2px").style("stroke-dasharray", "5,5");
      });
      messages.forEach((message, messageIndex) => {
        const fromParticipant = participants.find((p) => p.name === message.from);
        const toParticipant = participants.find((p) => p.name === message.to);
        if (!fromParticipant || !toParticipant) {
          return;
        }
        const fromIndex = participants.indexOf(fromParticipant);
        const toIndex = participants.indexOf(toParticipant);
        const fromX = 50 + fromIndex * participantSpacing;
        const toX = 50 + toIndex * participantSpacing;
        const messageY = 120 + messageIndex * messageHeight;
        const messageGroup = diagramGroup.append("g").attr("class", "sequence-message").on("click", () => {
          postMessage({ command: "jumpToElement", elementName: message.name });
        }).style("cursor", "pointer");
        const arrowPath = fromX < toX ? "M " + fromX + " " + messageY + " L " + (toX - 10) + " " + messageY + " L " + (toX - 20) + " " + (messageY - 5) + " M " + (toX - 10) + " " + messageY + " L " + (toX - 20) + " " + (messageY + 5) : "M " + fromX + " " + messageY + " L " + (toX + 10) + " " + messageY + " L " + (toX + 20) + " " + (messageY - 5) + " M " + (toX + 10) + " " + messageY + " L " + (toX + 20) + " " + (messageY + 5);
        messageGroup.append("path").attr("d", arrowPath).style("stroke", "var(--vscode-charts-blue)").style("stroke-width", "2px").style("fill", "none");
        const labelX = (fromX + toX) / 2;
        const labelText = message.payload || message.name;
        const labelWidth = Math.max(100, labelText.length * 8);
        messageGroup.append("rect").attr("x", labelX - labelWidth / 2).attr("y", messageY - 25).attr("width", labelWidth).attr("height", 20).attr("rx", 4).style("fill", "var(--vscode-editor-background)").style("stroke", "var(--vscode-charts-blue)").style("stroke-width", "1px");
        messageGroup.append("text").attr("x", labelX).attr("y", messageY - 10).attr("text-anchor", "middle").text(labelText).style("font-size", "12px").style("fill", "var(--vscode-editor-foreground)").style("pointer-events", "none");
        if (message.occurrence > 0) {
          messageGroup.append("text").attr("x", Math.min(fromX, toX) - 30).attr("y", messageY + 5).text(message.occurrence + "s").style("font-size", "10px").style("fill", "var(--vscode-descriptionForeground)").style("font-style", "italic");
        }
      });
      currentY += diagramHeight + 100;
    });
  }

  // src/visualization/webview/renderers/ibd.ts
  async function renderIbdView(ctx, data) {
    const { width, height, svg: svg2, g: g2, layoutDirection: layoutDirection2, postMessage, onStartInlineEdit, renderPlaceholder, clearVisualHighlights: clearVisualHighlights2 } = ctx;
    if (!data || !data.parts || data.parts.length === 0) {
      renderPlaceholder(
        width,
        height,
        "Interconnection View",
        "No parts or internal structure found to display.\\n\\nThis view shows internal block diagrams with parts, ports, and connectors.",
        data
      );
      return;
    }
    const parts = data.parts || [];
    const ports = data.ports || [];
    const connectors = data.connectors || [];
    const isHorizontal = layoutDirection2 === "horizontal";
    const partWidth = 280;
    const padding = 140;
    const horizontalSpacing = 160;
    const verticalSpacing = 100;
    const toDot = (qn) => (qn || "").replace(/::/g, ".");
    const partToElkId = (p) => toDot(p.qualifiedName) || p.id || p.name;
    parts.forEach((part, index) => {
      if (!part.id) part.id = part.name || "part-" + index;
    });
    const calculatePartHeight = (part) => {
      const partPorts = ports.filter((p) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
      const partChildren = part.children || [];
      let contentLineCount = 0;
      partPorts.forEach((p) => {
        if (p && p.name) {
          contentLineCount++;
          if (p.properties) contentLineCount += Object.keys(p.properties).length;
          if (p.attributes) {
            if (typeof p.attributes.forEach === "function") {
              p.attributes.forEach(() => contentLineCount++);
            } else if (typeof p.attributes === "object") {
              contentLineCount += Object.keys(p.attributes).filter((k) => k !== "isRedefinition").length;
            }
          }
          if (p.children) {
            contentLineCount += p.children.filter((c) => c.type === "redefinition" && c.name).length;
          }
        }
      });
      partChildren.forEach((c) => {
        if (!c || !c.name || !c.type) return;
        if (c.type === "part" || c.type === "port") {
          contentLineCount++;
          if (c.properties) contentLineCount += Object.keys(c.properties).length;
          if (c.attributes) {
            if (typeof c.attributes.forEach === "function") {
              c.attributes.forEach(() => contentLineCount++);
            } else if (typeof c.attributes === "object") {
              contentLineCount += Object.keys(c.attributes).filter((k) => k !== "isRedefinition").length;
            }
          }
          if (c.children) {
            contentLineCount += c.children.filter((gc) => gc.type === "redefinition" && gc.name).length;
          }
        } else if (c.type === "redefinition" || c.type === "attribute" || c.type === "property" || c.type === "state") {
          contentLineCount++;
        }
      });
      let hasTypedBy = false;
      if (part.attributes && part.attributes.get) {
        hasTypedBy = !!(part.attributes.get("partType") || part.attributes.get("type") || part.attributes.get("typedBy"));
      }
      if (!hasTypedBy && part.partType) hasTypedBy = true;
      const lineHeight = 12;
      const headerHeight = hasTypedBy ? 50 : 38;
      const contentHeight = contentLineCount * lineHeight + 10;
      const portsHeight = partPorts.length * 16 + 10;
      return Math.max(80, headerHeight + contentHeight + portsHeight);
    };
    const partHeights = /* @__PURE__ */ new Map();
    parts.forEach((part) => {
      partHeights.set(part.name, calculatePartHeight(part));
      if (part.id) partHeights.set(part.id, calculatePartHeight(part));
    });
    const getPartChildren = (p) => parts.filter(
      (c) => c.containerId === p.name || c.containerId === p.id || c.containerId === p.qualifiedName || toDot(c.containerId) === toDot(p.qualifiedName)
    );
    const buildTree = (part) => ({
      part,
      children: getPartChildren(part).map((c) => buildTree(c))
    });
    const roots = parts.filter((p) => p.containerId == null || p.containerId === void 0 || p.containerId === "");
    const rootPart = roots.length > 0 ? roots.reduce((a, b) => getPartChildren(a).length >= getPartChildren(b).length ? a : b) : parts[0];
    const partTree = rootPart ? buildTree(rootPart) : null;
    const rootName = rootPart ? rootPart.name : "";
    const leafParts = parts.filter((p) => getPartChildren(p).length === 0);
    const leafPartIds = new Set(leafParts.map((p) => partToElkId(p)));
    const findPartForEndpoint = (endpointPath) => {
      if (!endpointPath) return null;
      const pathDot = endpointPath.indexOf("::") >= 0 ? endpointPath.substring(endpointPath.lastIndexOf("::") + 2) : endpointPath;
      let best = null;
      for (const part of parts) {
        const qn = toDot(part.qualifiedName || part.name);
        if (!qn) continue;
        if (pathDot === qn || pathDot.startsWith(qn + ".")) {
          if (!best || qn.length > best.len) best = { part, len: qn.length };
        }
      }
      return best?.part ?? null;
    };
    let elkLaidOut = null;
    const useElk = typeof ELK !== "undefined" && ctx.elkWorkerUrl && partTree;
    if (useElk) {
      try {
        const elk = new ELK({ workerUrl: ctx.elkWorkerUrl || void 0 });
        const treeToElkNode = (node) => {
          const part = node.part;
          const id = partToElkId(part);
          const h = partHeights.get(part.name) || 80;
          if (node.children.length === 0) {
            return {
              id,
              width: partWidth,
              height: h,
              ports: [
                { id: id + "_west", layoutOptions: { "org.eclipse.elk.port.side": "WEST" } },
                { id: id + "_east", layoutOptions: { "org.eclipse.elk.port.side": "EAST" } }
              ]
            };
          }
          const childNodes = node.children.map((c) => treeToElkNode(c));
          const minW = Math.max(partWidth, 400);
          const minH = rootHeaderHeight + 120;
          return {
            id,
            width: minW,
            height: minH,
            children: childNodes
          };
        };
        const elkEdges = [];
        connectors.forEach((conn, idx) => {
          const srcPart = findPartForEndpoint(conn.sourceId || conn.source);
          const tgtPart = findPartForEndpoint(conn.targetId || conn.target);
          if (!srcPart || !tgtPart || !leafPartIds.has(partToElkId(srcPart)) || !leafPartIds.has(partToElkId(tgtPart))) return;
          elkEdges.push({
            id: "edge-" + idx,
            sources: [partToElkId(srcPart) + "_east"],
            targets: [partToElkId(tgtPart) + "_west"]
          });
        });
        const elkGraph = {
          id: "root",
          layoutOptions: {
            "elk.algorithm": "layered",
            "elk.hierarchyHandling": "INCLUDE_CHILDREN",
            "elk.direction": "RIGHT",
            "elk.spacing.nodeNode": "80",
            "elk.layered.spacing.nodeNodeBetweenLayers": "120",
            "elk.spacing.edgeNode": "60",
            "elk.spacing.edgeEdge": "40",
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
            "elk.separateConnectedComponents": "true",
            "elk.padding": "[top=60,left=60,bottom=60,right=60]",
            "org.eclipse.elk.portConstraints": "FIXED_SIDE",
            "org.eclipse.elk.json.edgeCoords": "ROOT"
          },
          children: [treeToElkNode(partTree)],
          edges: elkEdges
        };
        elkLaidOut = await elk.layout(elkGraph);
      } catch (e) {
        console.warn("[IBD] ELK layout failed, using tree layout:", e);
        elkLaidOut = null;
      }
    }
    const partPositions = /* @__PURE__ */ new Map();
    const innerMargin = 24;
    const rootHeaderHeight = 28;
    const relativePath = (qualifiedName) => {
      if (!rootName || !qualifiedName) return qualifiedName;
      const prefix = rootName + ".";
      return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : qualifiedName;
    };
    const setPos = (part, posData) => {
      partPositions.set(part.name, posData);
      partPositions.set(part.id, posData);
      if (part.qualifiedName && part.qualifiedName !== part.name) {
        partPositions.set(part.qualifiedName, posData);
      }
      partPositions.set(partToElkId(part), posData);
      const rel = relativePath(part.qualifiedName || part.name);
      if (rel && rel !== part.name) partPositions.set(rel, posData);
    };
    const idToPart = /* @__PURE__ */ new Map();
    parts.forEach((p) => idToPart.set(partToElkId(p), p));
    const extractElkPositions = (elkNode, parentAbsX, parentAbsY, depth) => {
      const part = idToPart.get(elkNode.id);
      if (!part) return;
      const absX = parentAbsX + (elkNode.x ?? 0);
      const absY = parentAbsY + (elkNode.y ?? 0);
      const w = elkNode.width ?? partWidth;
      const h = elkNode.height ?? (partHeights.get(part.name) || 80);
      const isContainer = elkNode.children && elkNode.children.length > 0;
      const posData = { x: absX + padding, y: absY + padding, part, height: h, width: w, isContainer, depth };
      setPos(part, posData);
      if (elkNode.children && elkNode.children.length > 0) {
        elkNode.children.forEach((ch) => extractElkPositions(ch, absX, absY, depth + 1));
      }
    };
    if (elkLaidOut && elkLaidOut.children && elkLaidOut.children.length > 0) {
      const rootElk = elkLaidOut.children[0];
      extractElkPositions(rootElk, 0, 0, 0);
    } else if (partTree) {
      const placeNode = (node, baseX, baseY, depth) => {
        const part = node.part;
        const h = partHeights.get(part.name) || 80;
        if (node.children.length === 0) {
          const posData2 = { x: baseX, y: baseY, part, height: h, width: partWidth, depth };
          setPos(part, posData2);
          return { width: partWidth, height: h };
        }
        const childSpacingH = horizontalSpacing;
        const childSpacingV = verticalSpacing;
        const cols = isHorizontal ? Math.ceil(Math.sqrt(node.children.length * 1.5)) : Math.max(1, Math.ceil(Math.sqrt(node.children.length)));
        let rowHeights = [];
        let maxW = 0;
        let curX = baseX + innerMargin;
        let curY = baseY + innerMargin;
        let rowMaxH = 0;
        let colIdx = 0;
        for (const child of node.children) {
          const size = placeNode(child, curX, curY, depth + 1);
          rowMaxH = Math.max(rowMaxH, size.height);
          maxW = Math.max(maxW, curX - baseX + size.width);
          colIdx++;
          if (colIdx >= cols) {
            curY += rowMaxH + childSpacingV;
            rowHeights.push(rowMaxH);
            curX = baseX + innerMargin;
            rowMaxH = 0;
            colIdx = 0;
          } else {
            curX += size.width + childSpacingH;
          }
        }
        if (rowMaxH > 0) rowHeights.push(rowMaxH);
        const contentW = maxW + innerMargin;
        const contentH = curY - baseY + (colIdx > 0 ? rowMaxH : 0) + innerMargin;
        const frameW = Math.max(partWidth, contentW);
        const frameH = rootHeaderHeight + contentH;
        const posData = { x: baseX, y: baseY, part, height: frameH, width: frameW, isContainer: true, depth };
        setPos(part, posData);
        return { width: frameW, height: frameH };
      };
      placeNode(partTree, padding, padding, 0);
    } else {
      parts.forEach((part) => {
        const posData = {
          x: padding,
          y: padding,
          part,
          height: partHeights.get(part.name) || 80,
          width: partWidth,
          depth: 0
        };
        setPos(part, posData);
      });
    }
    const parsePathToPoints = (d) => {
      const pts = [];
      const tokens = d.replace(/[ML]/gi, " ").replace(/,/g, " ").trim().split(/\s+/);
      let i = 0;
      while (i + 1 < tokens.length) {
        const x = parseFloat(tokens[i]);
        const y = parseFloat(tokens[i + 1]);
        if (!Number.isNaN(x) && !Number.isNaN(y)) pts.push({ x, y });
        i += 2;
      }
      return pts;
    };
    const pointsToPathD = (pts) => {
      if (pts.length === 0) return "";
      let s = "M" + pts[0].x + "," + pts[0].y;
      for (let i = 1; i < pts.length; i++) s += " L" + pts[i].x + "," + pts[i].y;
      return s;
    };
    const rectIntersectsHSeg = (y, x1, x2, r, margin) => {
      const yMin = r.y - margin, yMax = r.y + r.height + margin;
      if (y < yMin || y > yMax) return false;
      const xMin = Math.min(x1, x2) - margin, xMax = Math.max(x1, x2) + margin;
      return !(xMax < r.x || xMin > r.x + r.width);
    };
    const rectIntersectsVSeg = (x, y1, y2, r, margin) => {
      const xMin = r.x - margin, xMax = r.x + r.width + margin;
      if (x < xMin || x > xMax) return false;
      const yMin = Math.min(y1, y2) - margin, yMax = Math.max(y1, y2) + margin;
      return !(yMax < r.y || yMin > r.y + r.height);
    };
    const OBSTACLE_MARGIN = 10;
    const MAX_DETOUR_DEPTH = 4;
    const routeAroundLeafObstacles = (points, obstacles, depth = 0) => {
      if (points.length < 2 || obstacles.length === 0 || depth >= MAX_DETOUR_DEPTH) return points;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const isHoriz = Math.abs(a.y - b.y) < 1e-6;
        const isVert = Math.abs(a.x - b.x) < 1e-6;
        if (!isHoriz && !isVert) continue;
        for (const r of obstacles) {
          const hits = isHoriz ? rectIntersectsHSeg(a.y, a.x, b.x, r, OBSTACLE_MARGIN) : rectIntersectsVSeg(a.x, a.y, b.y, r, OBSTACLE_MARGIN);
          if (!hits) continue;
          if (isHoriz) {
            const aboveY = r.y - OBSTACLE_MARGIN;
            const belowY = r.y + r.height + OBSTACLE_MARGIN;
            const above = [a, { x: a.x, y: aboveY }, { x: b.x, y: aboveY }, b];
            const below = [a, { x: a.x, y: belowY }, { x: b.x, y: belowY }, b];
            const newObs = obstacles.filter((o) => o !== r);
            const mergedAbove = [...points.slice(0, i), ...above, ...points.slice(i + 2)];
            const mergedBelow = [...points.slice(0, i), ...below, ...points.slice(i + 2)];
            const resultAbove = routeAroundLeafObstacles(mergedAbove, newObs, depth + 1);
            const resultBelow = routeAroundLeafObstacles(mergedBelow, newObs, depth + 1);
            const lenAbove = resultAbove.reduce((sum, p, j) => {
              if (j === 0) return 0;
              return sum + Math.abs(resultAbove[j].x - resultAbove[j - 1].x) + Math.abs(resultAbove[j].y - resultAbove[j - 1].y);
            }, 0);
            const lenBelow = resultBelow.reduce((sum, p, j) => {
              if (j === 0) return 0;
              return sum + Math.abs(resultBelow[j].x - resultBelow[j - 1].x) + Math.abs(resultBelow[j].y - resultBelow[j - 1].y);
            }, 0);
            return lenAbove <= lenBelow ? resultAbove : resultBelow;
          } else {
            const leftX = r.x - OBSTACLE_MARGIN;
            const rightX = r.x + r.width + OBSTACLE_MARGIN;
            const left = [a, { x: leftX, y: a.y }, { x: leftX, y: b.y }, b];
            const right = [a, { x: rightX, y: a.y }, { x: rightX, y: b.y }, b];
            const newObs = obstacles.filter((o) => o !== r);
            const mergedLeft = [...points.slice(0, i), ...left, ...points.slice(i + 2)];
            const mergedRight = [...points.slice(0, i), ...right, ...points.slice(i + 2)];
            const resultLeft = routeAroundLeafObstacles(mergedLeft, newObs, depth + 1);
            const resultRight = routeAroundLeafObstacles(mergedRight, newObs, depth + 1);
            const lenLeft = resultLeft.reduce((sum, p, j) => {
              if (j === 0) return 0;
              return sum + Math.abs(resultLeft[j].x - resultLeft[j - 1].x) + Math.abs(resultLeft[j].y - resultLeft[j - 1].y);
            }, 0);
            const lenRight = resultRight.reduce((sum, p, j) => {
              if (j === 0) return 0;
              return sum + Math.abs(resultRight[j].x - resultRight[j - 1].x) + Math.abs(resultRight[j].y - resultRight[j - 1].y);
            }, 0);
            return lenLeft <= lenRight ? resultLeft : resultRight;
          }
        }
      }
      return points;
    };
    const pathFromElkSectionsWithPorts = (sections, srcX, srcY, tgtX, tgtY) => {
      if (!sections || sections.length === 0) return null;
      const sec = sections[0];
      if (!sec?.startPoint || !sec?.endPoint) return null;
      const bp = sec.bendPoints || [];
      const px = (x) => x + padding;
      const parts2 = ["M" + srcX + "," + srcY];
      for (const p of bp) {
        parts2.push("L" + px(p.x) + "," + px(p.y));
      }
      parts2.push("L" + tgtX + "," + tgtY);
      return parts2.join(" ");
    };
    const findPartPos = (qualifiedName) => {
      if (!qualifiedName) return null;
      const normalized = qualifiedName.lastIndexOf("::") >= 0 ? qualifiedName.substring(qualifiedName.lastIndexOf("::") + 2) : qualifiedName;
      if (partPositions.has(normalized)) {
        return partPositions.get(normalized);
      }
      if (partPositions.has(qualifiedName)) {
        return partPositions.get(qualifiedName);
      }
      const segments = normalized.split(".");
      for (let i = segments.length - 1; i >= 1; i--) {
        const partialPath = segments.slice(0, i).join(".");
        const pos = partPositions.get(partialPath);
        if (pos) return pos;
      }
      for (let i = segments.length - 1; i >= 0; i--) {
        const pos = partPositions.get(segments[i]);
        if (pos) return pos;
      }
      return null;
    };
    const defs = svg2.select("defs").empty() ? svg2.append("defs") : svg2.select("defs");
    defs.append("marker").attr("id", "ibd-flow-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", 0).attr("markerWidth", 8).attr("markerHeight", 8).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4Z").style("fill", "var(--vscode-charts-blue)");
    defs.append("marker").attr("id", "ibd-interface-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", 0).attr("markerWidth", 8).attr("markerHeight", 8).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4Z").style("fill", "none").style("stroke", "var(--vscode-charts-blue)").style("stroke-width", "1.5px");
    defs.append("marker").attr("id", "ibd-connection-dot").attr("viewBox", "0 0 10 10").attr("refX", 5).attr("refY", 5).attr("markerWidth", 5).attr("markerHeight", 5).append("circle").attr("cx", 5).attr("cy", 5).attr("r", 4).style("fill", "var(--vscode-charts-blue)");
    defs.append("marker").attr("id", "ibd-port-connector").attr("viewBox", "0 0 8 8").attr("refX", 4).attr("refY", 4).attr("markerWidth", 4).attr("markerHeight", 4).append("rect").attr("x", 1).attr("y", 1).attr("width", 6).attr("height", 6).style("fill", "var(--vscode-charts-purple)");
    let connectorGroup = g2.append("g").attr("class", "ibd-connectors");
    let usedLabelPositions = [];
    let pendingLabels = [];
    function drawIbdConnectors() {
      g2.selectAll(".ibd-connectors").remove();
      g2.selectAll(".ibd-connector-labels").remove();
      connectorGroup = g2.append("g").attr("class", "ibd-connectors");
      usedLabelPositions = [];
      pendingLabels = [];
      const nodePairConnectors = /* @__PURE__ */ new Map();
      const portConnections = /* @__PURE__ */ new Map();
      connectors.forEach((connector, idx) => {
        const srcPos = findPartPos(connector.sourceId);
        const tgtPos = findPartPos(connector.targetId);
        if (!srcPos || !tgtPos) return;
        const srcKey = srcPos.part.name;
        const tgtKey = tgtPos.part.name;
        const pairKey = srcKey < tgtKey ? srcKey + "|" + tgtKey : tgtKey + "|" + srcKey;
        if (!nodePairConnectors.has(pairKey)) {
          nodePairConnectors.set(pairKey, []);
        }
        nodePairConnectors.get(pairKey).push({ connector, idx });
        const srcPortName = connector.sourceId ? connector.sourceId.split(".").pop() : null;
        const tgtPortName = connector.targetId ? connector.targetId.split(".").pop() : null;
        const portKey = srcKey + "." + (srcPortName || "edge") + "->" + tgtKey + "." + (tgtPortName || "edge");
        if (!portConnections.has(portKey)) {
          portConnections.set(portKey, []);
        }
        portConnections.get(portKey).push({ connector, idx });
      });
      const collectElkEdges = (node, acc) => {
        if (node?.edges) acc.push(...node.edges);
        (node?.children ?? []).forEach((c) => collectElkEdges(c, acc));
      };
      const allElkEdges = [];
      if (elkLaidOut) collectElkEdges(elkLaidOut, allElkEdges);
      const getLeafObstaclesExcluding = (srcPartName, tgtPartName) => {
        const rects = [];
        partPositions.forEach((pos, key) => {
          if (key !== pos.part.name) return;
          if (pos.isContainer) return;
          if (pos.part.name === srcPartName || pos.part.name === tgtPartName) return;
          rects.push({
            x: pos.x,
            y: pos.y,
            width: pos.width ?? partWidth,
            height: pos.height
          });
        });
        return rects;
      };
      const connectorOffsets = /* @__PURE__ */ new Map();
      nodePairConnectors.forEach((group) => {
        const count = group.length;
        const step = 25;
        group.forEach((item, i) => {
          const offset = (i - (count - 1) / 2) * step;
          connectorOffsets.set(item.idx, { offset, groupIndex: i, groupCount: count });
        });
      });
      partPositions.forEach((pos, partName) => {
        if (partName !== pos.part.name) return;
        const part = pos.part;
        const partPorts = ports.filter((p) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
        const portStartY = part.attributes && (part.attributes.get && (part.attributes.get("partType") || part.attributes.get("type"))) ? 70 : 58;
        partPorts.forEach((p, i) => {
          const portY = pos.y + portStartY + i * 28;
          usedLabelPositions.push({ x: pos.x - 50, y: portY, width: 80, height: 20 });
          usedLabelPositions.push({ x: pos.x + partWidth + 50, y: portY, width: 80, height: 20 });
        });
      });
      const findPortPosition = (partPos, portName) => {
        if (!partPos || !portName) return null;
        const part = partPos.part;
        const partPorts = ports.filter((p) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
        const portNameLower = portName.toLowerCase();
        const port = partPorts.find((p) => p && p.name && (p.name.toLowerCase() === portNameLower || portName.toLowerCase().includes(p.name.toLowerCase())));
        if (!port) return null;
        const portDirection = port.direction || "inout";
        const isInPort = portDirection === "in" || port.name && port.name.toLowerCase().includes("in");
        const isOutPort = portDirection === "out" || port.name && port.name.toLowerCase().includes("out");
        const inPorts = partPorts.filter((p) => p && p.name && (p.direction === "in" || p.name && p.name.toLowerCase().includes("in")));
        const outPorts = partPorts.filter((p) => p && p.name && (p.direction === "out" || p.name && p.name.toLowerCase().includes("out")));
        const inoutPorts = partPorts.filter((p) => p && p.name && !inPorts.includes(p) && !outPorts.includes(p));
        const portSize = 14;
        const portSpacing = 28;
        const contentStartY = part.attributes && (part.attributes.get && (part.attributes.get("partType") || part.attributes.get("type"))) ? 50 : 38;
        const portStartY = contentStartY + 20;
        let portY, portX;
        if (isInPort) {
          const idx = inPorts.findIndex((p) => p.name === port.name);
          portY = partPos.y + portStartY + idx * portSpacing;
          portX = partPos.x;
        } else if (isOutPort) {
          const idx = outPorts.findIndex((p) => p.name === port.name);
          portY = partPos.y + portStartY + idx * portSpacing;
          portX = partPos.x + partWidth;
        } else {
          const idx = inoutPorts.findIndex((p) => p.name === port.name);
          portY = partPos.y + portStartY + inPorts.length * portSpacing + idx * portSpacing;
          portX = partPos.x;
        }
        return { x: portX, y: portY, direction: portDirection, isLeft: portX === partPos.x };
      };
      connectors.forEach((connector, connIdx) => {
        const srcPos = findPartPos(connector.sourceId);
        const tgtPos = findPartPos(connector.targetId);
        if (!srcPos || !tgtPos) return;
        const srcPortName = connector.sourceId ? connector.sourceId.split(".").pop() : null;
        const tgtPortName = connector.targetId ? connector.targetId.split(".").pop() : null;
        const srcPortPos = findPortPosition(srcPos, srcPortName);
        const tgtPortPos = findPortPosition(tgtPos, tgtPortName);
        const srcHeight = srcPos.height || 80;
        const tgtHeight = tgtPos.height || 80;
        const offsetInfo = connectorOffsets.get(connIdx) || { offset: 0, groupIndex: 0, groupCount: 1 };
        const baseOffset = offsetInfo.offset;
        let srcX, srcY, tgtX, tgtY;
        if (srcPortPos) {
          srcX = srcPortPos.x;
          srcY = srcPortPos.y;
        } else {
          const srcCx = srcPos.x + partWidth / 2;
          const tgtCx = tgtPos.x + partWidth / 2;
          srcX = tgtCx > srcCx ? srcPos.x + partWidth : srcPos.x;
          srcY = srcPos.y + srcHeight / 2;
        }
        if (tgtPortPos) {
          tgtX = tgtPortPos.x;
          tgtY = tgtPortPos.y;
        } else {
          const srcCx = srcPos.x + partWidth / 2;
          const tgtCx = tgtPos.x + partWidth / 2;
          tgtX = tgtCx > srcCx ? tgtPos.x : tgtPos.x + partWidth;
          tgtY = tgtPos.y + tgtHeight / 2;
        }
        let pathD;
        let labelX, labelY;
        const standoff = 40;
        const elkEdge = allElkEdges.find((e) => e.id === "edge-" + connIdx);
        const elkPath = elkEdge?.sections && srcPortPos && tgtPortPos ? pathFromElkSectionsWithPorts(elkEdge.sections, srcX, srcY, tgtX, tgtY) : null;
        if (elkPath) {
          pathD = elkPath;
          const sec = elkEdge?.sections?.[0];
          const bp = sec?.bendPoints || [];
          if (bp.length > 0) {
            const mid = bp[Math.floor(bp.length / 2)];
            labelX = mid.x + padding;
            labelY = mid.y + padding;
          } else {
            labelX = (srcX + tgtX) / 2;
            labelY = (srcY + tgtY) / 2;
          }
        } else if (srcPortPos && tgtPortPos) {
          const srcIsLeft = srcPortPos.isLeft;
          const tgtIsLeft = tgtPortPos.isLeft;
          const routeXOffset = baseOffset;
          if (srcIsLeft && tgtIsLeft) {
            const routeX = Math.min(srcPos.x, tgtPos.x) - standoff - routeXOffset;
            pathD = "M" + srcX + "," + srcY + " L" + routeX + "," + srcY + " L" + routeX + "," + tgtY + " L" + tgtX + "," + tgtY;
            labelX = routeX;
            labelY = (srcY + tgtY) / 2;
          } else if (!srcIsLeft && !tgtIsLeft) {
            const routeX = Math.max(srcPos.x + partWidth, tgtPos.x + partWidth) + standoff + routeXOffset;
            pathD = "M" + srcX + "," + srcY + " L" + routeX + "," + srcY + " L" + routeX + "," + tgtY + " L" + tgtX + "," + tgtY;
            labelX = routeX;
            labelY = (srcY + tgtY) / 2;
          } else {
            const midX = (srcX + tgtX) / 2 + routeXOffset;
            pathD = "M" + srcX + "," + srcY + " L" + midX + "," + srcY + " L" + midX + "," + tgtY + " L" + tgtX + "," + tgtY;
            labelX = midX;
            labelY = (srcY + tgtY) / 2;
          }
        } else {
          const srcCx = srcPos.x + partWidth / 2;
          const srcCy = srcPos.y + srcHeight / 2;
          const tgtCx = tgtPos.x + partWidth / 2;
          const tgtCy = tgtPos.y + tgtHeight / 2;
          if (Math.abs(tgtCx - srcCx) > Math.abs(tgtCy - srcCy)) {
            const exitX = tgtCx > srcCx ? srcPos.x + partWidth : srcPos.x;
            const enterX = tgtCx > srcCx ? tgtPos.x : tgtPos.x + partWidth;
            const midX = (exitX + enterX) / 2 + baseOffset;
            const y1 = srcCy + baseOffset * 0.3;
            const y2 = tgtCy + baseOffset * 0.3;
            pathD = "M" + exitX + "," + y1 + " L" + midX + "," + y1 + " L" + midX + "," + y2 + " L" + enterX + "," + y2;
            labelX = midX;
            labelY = (y1 + y2) / 2;
          } else {
            const exitY = tgtCy > srcCy ? srcPos.y + srcHeight : srcPos.y;
            const enterY = tgtCy > srcCy ? tgtPos.y : tgtPos.y + tgtHeight;
            const midY = (exitY + enterY) / 2 + baseOffset;
            const x1 = srcCx + baseOffset * 0.3;
            const x2 = tgtCx + baseOffset * 0.3;
            pathD = "M" + x1 + "," + exitY + " L" + x1 + "," + midY + " L" + x2 + "," + midY + " L" + x2 + "," + enterY;
            labelX = (x1 + x2) / 2;
            labelY = midY;
          }
        }
        const obstacles = getLeafObstaclesExcluding(srcPos.part.name, tgtPos.part.name);
        if (obstacles.length > 0) {
          const pts = parsePathToPoints(pathD);
          const routed = routeAroundLeafObstacles(pts, obstacles);
          if (routed.length >= 2) pathD = pointsToPathD(routed);
        }
        const connTypeLower = (connector.type || "").toLowerCase();
        const connNameLower = (connector.name || "").toLowerCase();
        const isFlow = connTypeLower === "flow" || connNameLower.includes("flow");
        const isInterface = connTypeLower === "interface" || connNameLower.includes("interface");
        const isBinding = connTypeLower === "binding" || connNameLower.includes("bind");
        let strokeStyle = "none";
        let strokeWidth = "2px";
        let markerStart = "none";
        let markerEnd = "none";
        let strokeColor = "var(--vscode-charts-blue)";
        if (isFlow) {
          markerEnd = "url(#ibd-flow-arrow)";
          strokeColor = "var(--vscode-charts-green)";
        } else if (isInterface) {
          markerEnd = "url(#ibd-interface-arrow)";
          strokeColor = "var(--vscode-charts-purple)";
        } else if (isBinding) {
          strokeStyle = "6,4";
          strokeWidth = "1.5px";
          markerStart = "url(#ibd-connection-dot)";
          markerEnd = "url(#ibd-connection-dot)";
        } else {
          markerStart = "url(#ibd-connection-dot)";
          markerEnd = "url(#ibd-connection-dot)";
        }
        const originalStroke = strokeColor;
        const originalStrokeWidth = strokeWidth;
        const connectorPath = connectorGroup.append("path").attr("d", pathD).attr("class", "ibd-connector").attr("data-connector-id", "connector-" + connIdx).attr("data-source", connector.sourceId || "").attr("data-target", connector.targetId || "").style("fill", "none").style("stroke", strokeColor).style("stroke-width", strokeWidth).style("stroke-dasharray", strokeStyle).style("marker-start", markerStart).style("marker-end", markerEnd).style("cursor", "pointer");
        connectorPath.on("click", function(event) {
          event.stopPropagation();
          d3.selectAll(".ibd-connector").each(function() {
            const el = d3.select(this);
            const origStroke = el.attr("data-original-stroke");
            const origWidth = el.attr("data-original-width");
            if (origStroke) {
              el.style("stroke", origStroke).style("stroke-width", origWidth).classed("connector-highlighted", false);
              el.attr("data-original-stroke", null).attr("data-original-width", null);
            }
          });
          const self = d3.select(this);
          self.attr("data-original-stroke", originalStroke).attr("data-original-width", originalStrokeWidth).style("stroke", "#FFD700").style("stroke-width", "4px").classed("connector-highlighted", true);
          this.parentNode.appendChild(this);
          postMessage({
            command: "connectorSelected",
            source: connector.sourceId,
            target: connector.targetId,
            type: connector.type,
            name: connector.name
          });
        });
        connectorPath.on("mouseenter", function() {
          const self = d3.select(this);
          if (!self.classed("connector-highlighted")) {
            self.style("stroke-width", "3px");
          }
        });
        connectorPath.on("mouseleave", function() {
          const self = d3.select(this);
          if (!self.classed("connector-highlighted")) {
            self.style("stroke-width", originalStrokeWidth);
          }
        });
        const label = connector.name || "";
        if (label && label !== "connection" && label !== "connector") {
          const displayLabel = label.length > 20 ? label.substring(0, 18) + ".." : label;
          const labelWidth = displayLabel.length * 7 + 20;
          const labelHeight = 20;
          let finalLabelX = labelX;
          let finalLabelY = labelY;
          let attempts = 0;
          const maxAttempts = 8;
          const offsets = [0, -25, 25, -50, 50, -75, 75, -100];
          while (attempts < maxAttempts) {
            const testY = labelY + offsets[attempts];
            const hasOverlap = usedLabelPositions.some((pos) => {
              return Math.abs(pos.x - labelX) < (pos.width + labelWidth) / 2 + 10 && Math.abs(pos.y - testY) < (pos.height + labelHeight) / 2 + 5;
            });
            if (!hasOverlap) {
              finalLabelY = testY;
              break;
            }
            attempts++;
          }
          usedLabelPositions.push({
            x: finalLabelX,
            y: finalLabelY,
            width: labelWidth,
            height: labelHeight
          });
          const isConnection = connTypeLower === "connection" || connTypeLower === "connect";
          const typeIndicator = isFlow ? "\u2192 " : isInterface ? "\u27E8\u27E9 " : isBinding ? "\u2261 " : isConnection ? "\u229E " : "";
          pendingLabels.push({
            x: finalLabelX,
            y: finalLabelY,
            width: labelWidth,
            height: labelHeight,
            text: typeIndicator + displayLabel,
            strokeColor
          });
        }
        if (isFlow && connector.itemType) {
          pendingLabels.push({
            x: labelX,
            y: labelY - 28,
            width: connector.itemType.length * 7 + 10,
            height: 16,
            text: "\xAB" + connector.itemType + "\xBB",
            strokeColor: "var(--vscode-charts-green)",
            isItemType: true
          });
        }
      });
      const labelGroup = g2.append("g").attr("class", "ibd-connector-labels");
      pendingLabels.forEach((labelData) => {
        if (labelData.isItemType) {
          labelGroup.append("text").attr("x", labelData.x).attr("y", labelData.y).attr("text-anchor", "middle").text(labelData.text).style("font-size", "9px").style("font-style", "italic").style("fill", labelData.strokeColor);
        } else {
          labelGroup.append("rect").attr("x", labelData.x - labelData.width / 2).attr("y", labelData.y - labelData.height / 2).attr("width", labelData.width).attr("height", labelData.height).attr("rx", 4).style("fill", "var(--vscode-editor-background)").style("stroke", labelData.strokeColor).style("stroke-width", "1px");
          labelGroup.append("text").attr("x", labelData.x).attr("y", labelData.y + 4).attr("text-anchor", "middle").text(labelData.text).style("font-size", "10px").style("font-weight", "600").style("fill", labelData.strokeColor);
        }
      });
    }
    const partGroup = g2.append("g").attr("class", "ibd-parts");
    const drawnPartIds = /* @__PURE__ */ new Set();
    const partEntries = Array.from(partPositions.entries());
    const byDepth = partEntries.sort((a, b) => {
      const da = a[1].depth ?? 999;
      const db = b[1].depth ?? 999;
      return da - db;
    });
    byDepth.forEach(([partName, pos]) => {
      if (partName !== pos.part.name) return;
      const partId = pos.part.id || pos.part.name;
      if (drawnPartIds.has(partId)) return;
      drawnPartIds.add(partId);
      const part = pos.part;
      if (!part || !part.name) {
        console.error("[IBD Render] Invalid part in partPositions:", part);
        return;
      }
      const typeLower = (part.type || "").toLowerCase();
      const typeColor = getTypeColor(part.type);
      const isLibValidated = isLibraryValidated(part);
      const isDefinition = typeLower.includes("def");
      const isUsage = !isDefinition;
      let typedByName = null;
      if (part.attributes && part.attributes.get) {
        typedByName = part.attributes.get("partType") || part.attributes.get("type") || part.attributes.get("typedBy");
      }
      if (!typedByName && part.partType) typedByName = part.partType;
      const partPorts = ports.filter((p) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
      const partChildren = part.children || [];
      const contentLines = [];
      const formatProperties = (obj) => {
        const props = [];
        if (obj.properties) {
          if (typeof obj.properties === "object") {
            Object.entries(obj.properties).forEach(([key, value]) => {
              if (value !== null && value !== void 0) {
                props.push("  :>> " + key + " = " + value);
              }
            });
          }
        }
        if (obj.attributes) {
          if (typeof obj.attributes.forEach === "function") {
            obj.attributes.forEach((value, key) => {
              if (value !== null && value !== void 0 && key !== "isRedefinition") {
                props.push("  " + key + " = " + value);
              }
            });
          } else if (typeof obj.attributes === "object") {
            Object.entries(obj.attributes).forEach(([key, value]) => {
              if (value !== null && value !== void 0 && key !== "isRedefinition") {
                props.push("  " + key + " = " + value);
              }
            });
          }
        }
        return props;
      };
      partPorts.forEach((p) => {
        if (p && p.name) {
          contentLines.push("[port] " + p.name);
          contentLines.push(...formatProperties(p));
          if (p.children && p.children.length > 0) {
            p.children.forEach((child) => {
              if (child.type === "redefinition" && child.name) {
                const value = child.attributes && child.attributes.get ? child.attributes.get("value") : child.attributes && child.attributes.value;
                if (value) {
                  contentLines.push("  :>> " + child.name + " = " + value);
                }
              }
            });
          }
        }
      });
      partChildren.forEach((c) => {
        try {
          if (!c || !c.name || !c.type) return;
          if (c.type === "part") {
            contentLines.push("[part] " + c.name);
            contentLines.push(...formatProperties(c));
            if (c.children && c.children.length > 0) {
              c.children.forEach((grandchild) => {
                if (grandchild.type === "redefinition" && grandchild.name) {
                  const value = grandchild.attributes && grandchild.attributes.get ? grandchild.attributes.get("value") : grandchild.attributes && grandchild.attributes.value;
                  if (value) {
                    contentLines.push("  :>> " + grandchild.name + " = " + value);
                  }
                }
              });
            }
          } else if (c.type === "port") {
            contentLines.push("[port] " + c.name);
            contentLines.push(...formatProperties(c));
            if (c.children && c.children.length > 0) {
              c.children.forEach((grandchild) => {
                if (grandchild.type === "redefinition" && grandchild.name) {
                  const value = grandchild.attributes && grandchild.attributes.get ? grandchild.attributes.get("value") : grandchild.attributes && grandchild.attributes.value;
                  if (value) {
                    contentLines.push("  :>> " + grandchild.name + " = " + value);
                  }
                }
              });
            }
          } else if (c.type === "redefinition") {
            const value = c.attributes && c.attributes.get ? c.attributes.get("value") : c.attributes && c.attributes.value;
            if (value) {
              contentLines.push(":>> " + c.name + " = " + value);
            }
          } else if (c.type === "attribute" || c.type === "property") {
            const valueStr = c.value !== void 0 ? " = " + c.value : "";
            contentLines.push("[attr] " + c.name + valueStr);
          } else if (c.type === "state") {
            contentLines.push("[state] " + c.name);
          }
        } catch {
        }
      });
      const lineHeight = 12;
      const headerHeight = typedByName ? 50 : 38;
      const contentHeight = contentLines.length * lineHeight + 10;
      const portsHeight = partPorts.length * 16 + 10;
      const totalHeight = Math.max(80, headerHeight + contentHeight + portsHeight);
      const w = pos.width ?? partWidth;
      const h = pos.height ?? totalHeight;
      const partG = partGroup.append("g").attr("transform", "translate(" + pos.x + "," + pos.y + ")").attr("class", "ibd-part" + (isDefinition ? " definition-node" : " usage-node") + (pos.isContainer ? " ibd-container" : "")).attr("data-element-name", part.name).style("cursor", "pointer");
      if (pos.isContainer) {
        const depth = pos.depth ?? 0;
        const isIntermediate = depth === 1;
        const containerFill = isIntermediate ? "rgba(255,255,255,0.06)" : "var(--vscode-editor-background)";
        const containerStrokeWidth = isIntermediate ? "3px" : "2px";
        partG.append("rect").attr("width", w).attr("height", h).attr("rx", 8).attr("class", "graph-node-background").attr("data-original-stroke", typeColor).attr("data-original-width", containerStrokeWidth).style("fill", containerFill).style("stroke", typeColor).style("stroke-width", containerStrokeWidth).style("stroke-dasharray", "4,4");
        partG.append("rect").attr("width", w).attr("height", rootHeaderHeight).attr("rx", 6).attr("y", 0).style("fill", "var(--vscode-button-secondaryBackground)");
        partG.append("text").attr("x", w / 2).attr("y", rootHeaderHeight / 2 + 4).attr("text-anchor", "middle").text(part.name).style("font-size", "11px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)");
        partG.on("click", function(event) {
          event.stopPropagation();
          clearVisualHighlights2();
          partGroup.selectAll(".ibd-part").select(".graph-node-background, rect").each(function() {
            const r = d3.select(this);
            if (r.attr("data-original-stroke")) {
              r.style("stroke", r.attr("data-original-stroke")).style("stroke-width", r.attr("data-original-width"));
            }
          });
          partG.select("rect.graph-node-background").style("stroke", "#FFD700").style("stroke-width", "4px");
          const statusEl = document.getElementById("status-text");
          if (statusEl) statusEl.textContent = part.name + " [" + (part.type || "part") + "]";
        });
        return;
      }
      const _ibdStroke = isLibValidated ? GENERAL_VIEW_PALETTE.structural.part : typeColor;
      const _ibdStrokeW = isUsage ? "3px" : "2px";
      partG.append("rect").attr("width", partWidth).attr("height", totalHeight).attr("rx", isUsage ? 8 : 4).attr("data-original-stroke", _ibdStroke).attr("data-original-width", _ibdStrokeW).style("fill", "var(--vscode-editor-background)").style("stroke", _ibdStroke).style("stroke-width", _ibdStrokeW).style("stroke-dasharray", isDefinition ? "6,3" : "none");
      partG.append("rect").attr("width", partWidth).attr("height", 5).attr("rx", 2).style("fill", typeColor);
      partG.append("rect").attr("y", 5).attr("width", partWidth).attr("height", typedByName ? 36 : 28).style("fill", "var(--vscode-button-secondaryBackground)");
      let stereoDisplay = part.type || "part";
      if (typeLower.includes("part def")) stereoDisplay = "part def";
      else if (typeLower.includes("part")) stereoDisplay = "part";
      else if (typeLower.includes("port def")) stereoDisplay = "port def";
      else if (typeLower.includes("action def")) stereoDisplay = "action def";
      else if (typeLower.includes("action")) stereoDisplay = "action";
      partG.append("text").attr("x", partWidth / 2).attr("y", 17).attr("text-anchor", "middle").text("\xAB" + stereoDisplay + "\xBB").style("font-size", "9px").style("fill", typeColor);
      const displayName = part.name.length > 18 ? part.name.substring(0, 16) + ".." : part.name;
      partG.append("text").attr("class", "node-name-text").attr("data-element-name", part.name).attr("x", partWidth / 2).attr("y", 31).attr("text-anchor", "middle").text(displayName).style("font-size", "11px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)");
      if (typedByName) {
        partG.append("text").attr("x", partWidth / 2).attr("y", 43).attr("text-anchor", "middle").text(": " + (typedByName.length > 18 ? typedByName.substring(0, 16) + ".." : typedByName)).style("font-size", "10px").style("font-style", "italic").style("fill", "#569CD6");
      }
      const contentStartY = typedByName ? 50 : 38;
      contentLines.forEach((line, i) => {
        partG.append("text").attr("x", 6).attr("y", contentStartY + 8 + i * lineHeight).text(line.length > 28 ? line.substring(0, 26) + ".." : line).style("font-size", "9px").style("fill", "var(--vscode-descriptionForeground)");
      });
      const portSize = 14;
      const portSpacing = 28;
      const portStartY = contentStartY + 20;
      const inPorts = partPorts.filter((p) => p && p.name && (p.direction === "in" || p.name && p.name.toLowerCase().includes("in")));
      const outPorts = partPorts.filter((p) => p && p.name && (p.direction === "out" || p.name && p.name.toLowerCase().includes("out")));
      const inoutPorts = partPorts.filter((p) => p && p.name && !inPorts.includes(p) && !outPorts.includes(p));
      inPorts.forEach((p, i) => {
        const portY = portStartY + i * portSpacing;
        const portColor = GENERAL_VIEW_PALETTE.structural.port;
        partG.append("rect").attr("class", "port-icon").attr("x", -portSize / 2).attr("y", portY - portSize / 2).attr("width", portSize).attr("height", portSize).style("fill", portColor).style("stroke", "var(--vscode-editor-background)").style("stroke-width", "2px");
        partG.append("path").attr("d", "M" + (-portSize / 2 + 2) + "," + portY + " L" + (portSize / 2 - 2) + "," + portY + " M" + (portSize / 2 - 4) + "," + (portY - 2) + " L" + (portSize / 2 - 2) + "," + portY + " L" + (portSize / 2 - 4) + "," + (portY + 2)).style("stroke", "var(--vscode-editor-background)").style("stroke-width", "1.5px").style("fill", "none");
        const portLabel = p.name.length > 14 ? p.name.substring(0, 12) + ".." : p.name;
        partG.append("text").attr("x", -portSize / 2 - 10).attr("y", portY + 4).attr("text-anchor", "end").text(portLabel).style("font-size", "10px").style("font-weight", "500").style("fill", portColor);
      });
      outPorts.forEach((p, i) => {
        const portY = portStartY + i * portSpacing;
        const portColor = GENERAL_VIEW_PALETTE.structural.part;
        partG.append("rect").attr("class", "port-icon").attr("x", partWidth - portSize / 2).attr("y", portY - portSize / 2).attr("width", portSize).attr("height", portSize).style("fill", portColor).style("stroke", "var(--vscode-editor-background)").style("stroke-width", "2px");
        partG.append("path").attr("d", "M" + (partWidth - portSize / 2 + 2) + "," + portY + " L" + (partWidth + portSize / 2 - 2) + "," + portY + " M" + (partWidth + portSize / 2 - 4) + "," + (portY - 2) + " L" + (partWidth + portSize / 2 - 2) + "," + portY + " L" + (partWidth + portSize / 2 - 4) + "," + (portY + 2)).style("stroke", "var(--vscode-editor-background)").style("stroke-width", "1.5px").style("fill", "none");
        const portLabel = p.name.length > 14 ? p.name.substring(0, 12) + ".." : p.name;
        partG.append("text").attr("x", partWidth + portSize / 2 + 10).attr("y", portY + 4).attr("text-anchor", "start").text(portLabel).style("font-size", "10px").style("font-weight", "500").style("fill", portColor);
      });
      const inoutStartY = portStartY + inPorts.length * portSpacing;
      inoutPorts.forEach((p, i) => {
        const portY = inoutStartY + i * portSpacing;
        const portColor = GENERAL_VIEW_PALETTE.structural.attribute;
        partG.append("rect").attr("class", "port-icon").attr("x", -portSize / 2).attr("y", portY - portSize / 2).attr("width", portSize).attr("height", portSize).style("fill", portColor).style("stroke", "var(--vscode-editor-background)").style("stroke-width", "2px");
        partG.append("path").attr("d", "M" + (-portSize / 2 + 3) + "," + portY + " L" + (portSize / 2 - 3) + "," + portY).style("stroke", "var(--vscode-editor-background)").style("stroke-width", "1.5px").style("fill", "none");
        const portLabel = p.name.length > 14 ? p.name.substring(0, 12) + ".." : p.name;
        partG.append("text").attr("x", -portSize / 2 - 10).attr("y", portY + 4).attr("text-anchor", "end").text(portLabel).style("font-size", "10px").style("font-weight", "500").style("fill", portColor);
      });
      partG.on("click", function(event) {
        event.stopPropagation();
        clearVisualHighlights2();
        const clickedPart = d3.select(this);
        clickedPart.classed("highlighted-element", true);
        clickedPart.select("rect").style("stroke", "#FFD700").style("stroke-width", "3px");
        postMessage({ command: "jumpToElement", elementName: part.name, skipCentering: true });
      }).on("dblclick", function(event) {
        event.stopPropagation();
        onStartInlineEdit(d3.select(this), part.name, pos.x, pos.y, partWidth);
      });
      partG.style("cursor", "grab");
      const ibdDrag = d3.drag().on("start", function(event) {
        d3.select(this).raise().style("cursor", "grabbing");
        event.sourceEvent.stopPropagation();
      }).on("drag", function(event) {
        pos.x += event.dx;
        pos.y += event.dy;
        d3.select(this).attr("transform", "translate(" + pos.x + "," + pos.y + ")");
        drawIbdConnectors();
      }).on("end", function() {
        d3.select(this).style("cursor", "grab");
      });
      partG.call(ibdDrag);
    });
    drawIbdConnectors();
  }

  // src/visualization/webview/renderers/activity.ts
  function renderActivityView(ctx, data) {
    const { width, height, svg: svg2, g: g2, activityLayoutDirection: activityLayoutDirection2, activityDebugLabels: activityDebugLabels2, selectedDiagramIndex: selectedDiagramIndex2, postMessage, onStartInlineEdit, renderPlaceholder } = ctx;
    if (!data || !data.diagrams || data.diagrams.length === 0) {
      renderPlaceholder(
        width,
        height,
        "Action Flow View",
        "No activity diagrams found to display.\\n\\nThis view shows action flows with decisions, merge nodes, and swim lanes.",
        data
      );
      return;
    }
    const diagramIndex = Math.min(selectedDiagramIndex2, data.diagrams.length - 1);
    const diagram = data.diagrams[diagramIndex];
    const allActions = (diagram.actions || []).map((action, idx) => ({
      ...action,
      id: action.id || action.name || "action_" + idx,
      name: action.name || action.id || "Action " + (idx + 1)
    }));
    const actions = allActions.filter((action) => !action.parent);
    const nestedActions = allActions.filter((action) => action.parent);
    const containerChildren = /* @__PURE__ */ new Map();
    nestedActions.forEach((action) => {
      if (!containerChildren.has(action.parent)) {
        containerChildren.set(action.parent, []);
      }
      containerChildren.get(action.parent).push(action);
    });
    let flows = diagram.flows || [];
    if (flows.length === 0 && actions.length > 1) {
      flows = [];
      for (let i = 0; i < actions.length - 1; i++) {
        flows.push({
          from: actions[i].id || actions[i].name,
          to: actions[i + 1].id || actions[i + 1].name,
          type: "control"
        });
      }
    }
    const isHorizontal = activityLayoutDirection2 === "horizontal";
    const actionWidth = 220;
    const actionHeight = 60;
    const verticalSpacing = 100;
    const horizontalSpacing = 60;
    const startX = 80;
    const startY = 80;
    const swimLaneWidth = 280;
    const swimLanes = /* @__PURE__ */ new Map();
    const noLaneActions = [];
    actions.forEach((action) => {
      if (action.lane) {
        if (!swimLanes.has(action.lane)) {
          swimLanes.set(action.lane, []);
        }
        swimLanes.get(action.lane).push(action);
      } else {
        noLaneActions.push(action);
      }
    });
    const actionPositions = /* @__PURE__ */ new Map();
    const levels = /* @__PURE__ */ new Map();
    const visited = /* @__PURE__ */ new Set();
    function calculateLevel(actionId) {
      if (visited.has(actionId)) {
        return levels.get(actionId) || 0;
      }
      visited.add(actionId);
      const incomingFlows = flows.filter((f) => f.to === actionId);
      let maxSourceLevel = -1;
      incomingFlows.forEach((flow) => {
        const sourceLevel = calculateLevel(flow.from);
        maxSourceLevel = Math.max(maxSourceLevel, sourceLevel);
      });
      const level = maxSourceLevel + 1;
      levels.set(actionId, level);
      return level;
    }
    actions.forEach((action) => {
      if (!visited.has(action.id)) {
        calculateLevel(action.id);
      }
    });
    const actionsByLevel = /* @__PURE__ */ new Map();
    actions.forEach((action) => {
      const level = levels.get(action.id) || 0;
      if (!actionsByLevel.has(level)) {
        actionsByLevel.set(level, []);
      }
      actionsByLevel.get(level).push(action);
    });
    const childPadding = 10;
    const childActionHeight = 35;
    const childSpacing = 8;
    function getActionHeight(action) {
      const children = containerChildren.get(action.name || action.id);
      if (children && children.length > 0) {
        return 30 + children.length * (childActionHeight + childSpacing) + childPadding;
      }
      return actionHeight;
    }
    const levelYPositions = /* @__PURE__ */ new Map();
    const sortedLevels = Array.from(actionsByLevel.keys()).sort((a, b) => a - b);
    let cumulativeY = startY;
    sortedLevels.forEach((level) => {
      levelYPositions.set(level, cumulativeY);
      const actionsAtLevel = actionsByLevel.get(level) || [];
      const maxHeightAtLevel = Math.max(...actionsAtLevel.map((a) => getActionHeight(a)), actionHeight);
      cumulativeY += maxHeightAtLevel + verticalSpacing - actionHeight;
    });
    let laneIndex = 0;
    const lanePositions = /* @__PURE__ */ new Map();
    if (swimLanes.size > 0) {
      swimLanes.forEach((laneActions, laneName) => {
        const laneX = 60 + laneIndex * (swimLaneWidth + 40);
        lanePositions.set(laneName, { x: laneX, index: laneIndex });
        laneActions.forEach((action) => {
          const level = levels.get(action.id) || 0;
          actionPositions.set(action.id, {
            x: laneX + (swimLaneWidth - actionWidth) / 2,
            y: levelYPositions.get(level) || startY + level * verticalSpacing,
            action
          });
        });
        laneIndex++;
      });
      if (noLaneActions.length > 0) {
        const noLaneX = 60 + laneIndex * (swimLaneWidth + 40);
        const noLaneActionsByLevel = /* @__PURE__ */ new Map();
        noLaneActions.forEach((action) => {
          const level = levels.get(action.id) || 0;
          if (!noLaneActionsByLevel.has(level)) {
            noLaneActionsByLevel.set(level, []);
          }
          noLaneActionsByLevel.get(level).push(action);
        });
        noLaneActions.forEach((action) => {
          const level = levels.get(action.id) || 0;
          const actionsAtLevel = noLaneActionsByLevel.get(level) || [action];
          const positionInLevel = actionsAtLevel.indexOf(action);
          const totalAtLevel = actionsAtLevel.length;
          const centerOffset = (totalAtLevel - 1) * (actionWidth + horizontalSpacing) / 2;
          actionPositions.set(action.id, {
            x: noLaneX + swimLaneWidth / 2 - centerOffset + positionInLevel * (actionWidth + horizontalSpacing),
            y: levelYPositions.get(level) || startY + level * verticalSpacing,
            action
          });
        });
      }
    } else {
      actions.forEach((action) => {
        const level = levels.get(action.id) || 0;
        const actionsAtLevel = actionsByLevel.get(level) || [action];
        const positionInLevel = actionsAtLevel.indexOf(action);
        const totalAtLevel = actionsAtLevel.length;
        if (isHorizontal) {
          const centerOffset = (totalAtLevel - 1) * (actionHeight + verticalSpacing) / 2;
          actionPositions.set(action.id, {
            x: startX + level * (actionWidth + horizontalSpacing),
            y: height / 2 - centerOffset + positionInLevel * (actionHeight + verticalSpacing),
            action
          });
        } else {
          const centerOffset = (totalAtLevel - 1) * (actionWidth + horizontalSpacing) / 2;
          const yPos = levelYPositions.get(level) || startY + level * verticalSpacing;
          actionPositions.set(action.id, {
            x: width / 2 - centerOffset + positionInLevel * (actionWidth + horizontalSpacing),
            y: yPos,
            action
          });
        }
      });
    }
    if (swimLanes.size > 0) {
      const maxLevel = Math.max(...Array.from(levels.values()), 0);
      const lastLevelY = levelYPositions.get(maxLevel) || startY + maxLevel * verticalSpacing;
      const laneHeight = lastLevelY + 100;
      lanePositions.forEach((pos, laneName) => {
        g2.append("rect").attr("x", pos.x - 10).attr("y", 20).attr("width", swimLaneWidth).attr("height", laneHeight).attr("rx", 4).style("fill", "none").style("stroke", "var(--vscode-panel-border)").style("stroke-width", "2px").style("stroke-dasharray", "5,5").style("opacity", 0.5);
        g2.append("text").attr("x", pos.x + swimLaneWidth / 2).attr("y", 40).attr("text-anchor", "middle").text(laneName).style("font-size", "12px").style("font-weight", "bold").style("fill", "var(--vscode-descriptionForeground)");
      });
    }
    const flowGroup = g2.append("g").attr("class", "activity-flows");
    const flowsFromSource = /* @__PURE__ */ new Map();
    flows.forEach((flow) => {
      if (!flowsFromSource.has(flow.from)) {
        flowsFromSource.set(flow.from, []);
      }
      flowsFromSource.get(flow.from).push(flow);
    });
    const flowsToTarget = /* @__PURE__ */ new Map();
    flows.forEach((flow) => {
      if (!flowsToTarget.has(flow.to)) {
        flowsToTarget.set(flow.to, []);
      }
      flowsToTarget.get(flow.to).push(flow);
    });
    flows.forEach((flow) => {
      const sourcePos = actionPositions.get(flow.from);
      const targetPos = actionPositions.get(flow.to);
      if (!sourcePos || !targetPos) return;
      let pathData;
      let labelX, labelY;
      const siblingsFromSource = flowsFromSource.get(flow.from) || [flow];
      const siblingIndexFromSource = siblingsFromSource.indexOf(flow);
      const totalSiblingsFromSource = siblingsFromSource.length;
      const siblingsToTarget = flowsToTarget.get(flow.to) || [flow];
      const siblingIndexToTarget = siblingsToTarget.indexOf(flow);
      const totalSiblingsToTarget = siblingsToTarget.length;
      if (isHorizontal) {
        const flowStartX = sourcePos.x + actionWidth;
        const flowStartY = sourcePos.y + actionHeight / 2;
        const endX = targetPos.x;
        const endY = targetPos.y + actionHeight / 2;
        const midX = (flowStartX + endX) / 2;
        pathData = "M " + flowStartX + "," + flowStartY + " L " + midX + "," + flowStartY + " L " + midX + "," + endY + " L " + endX + "," + endY;
        labelX = midX;
        labelY = (flowStartY + endY) / 2 - 5;
      } else {
        const flowStartX = sourcePos.x + actionWidth / 2;
        const flowStartY = sourcePos.y + actionHeight;
        const endX = targetPos.x + actionWidth / 2;
        const endY = targetPos.y;
        let startXOffset = 0;
        let endXOffset = 0;
        const isForkSource = sourcePos.action?.kind === "fork" || sourcePos.action?.type === "fork";
        const isJoinTarget = targetPos.action?.kind === "join" || targetPos.action?.type === "join";
        if (isForkSource && totalSiblingsFromSource > 1) {
          const offsetRange = Math.min(actionWidth * 0.8, 100);
          startXOffset = (siblingIndexFromSource - (totalSiblingsFromSource - 1) / 2) * (offsetRange / (totalSiblingsFromSource - 1 || 1));
        }
        if (isJoinTarget && totalSiblingsToTarget > 1) {
          const offsetRange = Math.min(actionWidth * 0.8, 100);
          endXOffset = (siblingIndexToTarget - (totalSiblingsToTarget - 1) / 2) * (offsetRange / (totalSiblingsToTarget - 1 || 1));
        }
        const adjustedStartX = flowStartX + startXOffset;
        const adjustedEndX = endX + endXOffset;
        let midY;
        if (isJoinTarget) {
          midY = endY - 15;
        } else {
          midY = (flowStartY + endY) / 2;
        }
        pathData = "M " + adjustedStartX + "," + flowStartY + " L " + adjustedStartX + "," + midY + " L " + adjustedEndX + "," + midY + " L " + adjustedEndX + "," + endY;
        labelX = (adjustedStartX + adjustedEndX) / 2;
        labelY = midY - 5;
      }
      flowGroup.append("path").attr("d", pathData).style("fill", "none").style("stroke", "var(--vscode-charts-blue)").style("stroke-width", "2px").style("marker-end", "url(#activity-arrowhead)");
      const guardLabel = flow.guard || flow.condition;
      if (guardLabel) {
        let displayLabel;
        const trimmedGuard = String(guardLabel).trim();
        const enumMatch = trimmedGuard.match(/::(\w+)/);
        if (enumMatch) {
          displayLabel = enumMatch[1];
        } else {
          displayLabel = trimmedGuard.length > 25 ? trimmedGuard.substring(0, 22) + "..." : trimmedGuard;
        }
        const labelText = "[" + displayLabel + "]";
        const labelWidth = labelText.length * 6 + 8;
        flowGroup.append("rect").attr("x", labelX - labelWidth / 2).attr("y", labelY - 10).attr("width", labelWidth).attr("height", 14).attr("rx", 3).style("fill", "var(--vscode-editor-background)").style("stroke", "var(--vscode-charts-orange)").style("stroke-width", "1px").style("opacity", 0.9);
        flowGroup.append("text").attr("x", labelX).attr("y", labelY).attr("text-anchor", "middle").text(labelText).style("font-size", "10px").style("fill", "var(--vscode-charts-orange)").style("font-weight", "bold");
      }
    });
    const defs = svg2.select("defs").empty() ? svg2.append("defs") : svg2.select("defs");
    defs.append("marker").attr("id", "activity-arrowhead").attr("viewBox", "0 -5 10 10").attr("refX", 8).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto").append("path").attr("d", "M0,-5L10,0L0,5").style("fill", "var(--vscode-charts-blue)");
    const actionGroup = g2.append("g").attr("class", "activity-actions");
    function truncateToFit(text, maxChars) {
      if (!text) return "";
      if (text.length <= maxChars) return text;
      return text.substring(0, maxChars - 2) + "..";
    }
    function handleActionClick(action) {
      if (action && action.name) {
        postMessage({
          command: "jumpToElement",
          elementName: action.name,
          parentContext: diagram.name
        });
      }
    }
    actionPositions.forEach((pos, actionId) => {
      const action = pos.action;
      const actionKind = (action.kind || action.type || "action").toLowerCase();
      const actionName = action.name || actionId || "unnamed";
      const isDecision = actionKind.includes("decision") || actionKind.includes("merge");
      const isFork = actionKind.includes("fork") || actionKind.includes("join");
      const isStart = actionKind.includes("initial") || actionKind.includes("start") || actionName === "start";
      const isEnd = actionKind.includes("final") || actionKind.includes("end") || actionKind.includes("done") || actionName === "done";
      const actionElement = actionGroup.append("g").attr("class", "activity-action").attr("transform", "translate(" + pos.x + "," + pos.y + ")").style("cursor", "pointer").on("click", function(event) {
        event.stopPropagation();
        handleActionClick(action);
      });
      if (isStart || isEnd) {
        actionElement.append("circle").attr("cx", actionWidth / 2).attr("cy", actionHeight / 2).attr("r", 20).style("fill", isStart ? "var(--vscode-charts-green)" : "var(--vscode-charts-red)").style("stroke", "var(--vscode-panel-border)").style("stroke-width", "3px");
        if (isEnd) {
          actionElement.append("circle").attr("cx", actionWidth / 2).attr("cy", actionHeight / 2).attr("r", 12).style("fill", "var(--vscode-charts-red)").style("stroke", "none");
        }
      } else if (isDecision) {
        const diamond = "M " + actionWidth / 2 + ",0 L " + actionWidth + "," + actionHeight / 2 + " L " + actionWidth / 2 + "," + actionHeight + " L 0," + actionHeight / 2 + " Z";
        actionElement.append("path").attr("d", diamond).style("fill", "var(--vscode-editor-background)").style("stroke", "var(--vscode-charts-orange)").style("stroke-width", "2px");
        let decisionLabel = "?";
        if (actionKind.includes("merge")) {
          decisionLabel = truncateToFit(actionName, 18);
        } else if (action.condition && action.condition !== "decide") {
          decisionLabel = truncateToFit(action.condition, 18);
        }
        actionElement.append("text").attr("x", actionWidth / 2).attr("y", actionHeight / 2 + 5).attr("text-anchor", "middle").text(decisionLabel).style("font-size", actionKind.includes("merge") ? "11px" : "16px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)").style("user-select", "none");
      } else if (isFork) {
        actionElement.append("rect").attr("x", 0).attr("y", actionHeight / 2 - 5).attr("width", actionWidth).attr("height", 10).attr("rx", 2).style("fill", "var(--vscode-panel-border)").style("stroke", "none");
        if (activityDebugLabels2) {
          actionElement.append("text").attr("class", "fork-join-debug-label").attr("x", actionWidth / 2).attr("y", actionHeight / 2 + 25).attr("text-anchor", "middle").text(actionName).style("font-size", "10px").style("fill", "var(--vscode-descriptionForeground)").style("font-style", "italic").style("user-select", "none");
        }
      } else {
        const children = containerChildren.get(actionName);
        const isContainer = children && children.length > 0;
        let containerWidth = actionWidth;
        let containerHeight = actionHeight;
        if (isContainer) {
          containerWidth = actionWidth + 20;
          containerHeight = 30 + children.length * (childActionHeight + childSpacing) + childPadding;
        }
        actionElement.append("rect").attr("width", containerWidth).attr("height", containerHeight).attr("rx", 8).style("fill", "var(--vscode-editor-background)").style("stroke", isContainer ? "var(--vscode-charts-purple)" : "var(--vscode-charts-blue)").style("stroke-width", isContainer ? "3px" : "2px");
        const maxChars = isContainer ? 28 : 24;
        const displayName = truncateToFit(actionName, maxChars);
        const fontSize = actionName.length > 20 ? "11px" : "13px";
        actionElement.append("text").attr("class", "node-name-text").attr("data-element-name", actionName).attr("x", containerWidth / 2).attr("y", isContainer ? 18 : containerHeight / 2 - 5).attr("text-anchor", "middle").text(displayName).style("font-size", fontSize).style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)").style("user-select", "none");
        if (isContainer) {
          let childY = 30;
          children.forEach((child) => {
            const childName = child.name || child;
            const childDisplayName = truncateToFit(childName, 22);
            actionElement.append("rect").attr("x", childPadding).attr("y", childY).attr("width", containerWidth - 2 * childPadding).attr("height", childActionHeight).attr("rx", 4).style("fill", "var(--vscode-editor-inactiveSelectionBackground)").style("stroke", "var(--vscode-charts-blue)").style("stroke-width", "1px").style("cursor", "pointer").on("click", function(event) {
              event.stopPropagation();
              handleActionClick(child);
            });
            actionElement.append("text").attr("class", "node-name-text").attr("data-element-name", childName).attr("x", containerWidth / 2).attr("y", childY + childActionHeight / 2 + 4).attr("text-anchor", "middle").text(childDisplayName).style("font-size", "11px").style("fill", "var(--vscode-editor-foreground)").style("pointer-events", "none").style("user-select", "none");
            childY += childActionHeight + childSpacing;
          });
        }
        if (!isContainer && actionKind !== "action" && actionKind !== displayName.toLowerCase()) {
          actionElement.append("text").attr("x", containerWidth / 2).attr("y", containerHeight / 2 + 12).attr("text-anchor", "middle").text("\xAB" + truncateToFit(actionKind, 14) + "\xBB").style("font-size", "9px").style("fill", "var(--vscode-descriptionForeground)").style("user-select", "none");
        }
        actionElement.on("dblclick", function(event) {
          event.stopPropagation();
          onStartInlineEdit(d3.select(this), actionName, pos.x, pos.y, containerWidth);
        });
      }
    });
  }

  // src/visualization/webview/renderers/state.ts
  function renderStateView(ctx, data) {
    const { width, height, svg: svg2, g: g2, stateLayoutOrientation: stateLayoutOrientation2, selectedDiagramIndex: selectedDiagramIndex2, postMessage, onStartInlineEdit, renderPlaceholder } = ctx;
    if (!data || !data.states || data.states.length === 0) {
      renderPlaceholder(
        width,
        height,
        "State Transition View",
        "No states found to display.\\n\\nThis view shows state machines with states, transitions, and guards.",
        data
      );
      return;
    }
    const allStates = data.states || [];
    const transitions = data.transitions || [];
    const stateMachineMap = /* @__PURE__ */ new Map();
    const orphanStates = [];
    function collectChildStates(container, collected = []) {
      if (container.children && container.children.length > 0) {
        container.children.forEach((child) => {
          const childType = (child.type || "").toLowerCase();
          const childName = (child.name || "").toLowerCase();
          const isNestedMachine = childName.endsWith("states") || childType.includes("exhibit");
          if (childType.includes("state") && !childType.includes("def")) {
            if (!isNestedMachine) {
              collected.push(child);
            }
          }
          if (!isNestedMachine && child.children) {
            collectChildStates(child, collected);
          }
        });
      }
      return collected;
    }
    function findStateMachines(stateList, depth = 0) {
      stateList.forEach((s) => {
        const typeLower = (s.type || "").toLowerCase();
        const nameLower = (s.name || "").toLowerCase();
        const isContainer = typeLower.includes("exhibit") || nameLower.endsWith("states") || typeLower.includes("state") && s.children && s.children.length > 0 && s.children.some((c) => (c.type || "").toLowerCase().includes("state"));
        const childStates = collectChildStates(s);
        const isStateMachine = isContainer && (childStates.length > 0 || !typeLower.includes("def"));
        if (isStateMachine) {
          stateMachineMap.set(s.name, {
            container: s,
            states: childStates,
            transitions: [],
            depth
          });
        }
        if (s.children && s.children.length > 0) {
          findStateMachines(s.children, depth + 1);
        }
      });
    }
    findStateMachines(allStates);
    allStates.forEach((s) => {
      const typeLower = (s.type || "").toLowerCase();
      if (typeLower.includes("def") || typeLower.includes("definition")) {
        return;
      }
      if (stateMachineMap.has(s.name)) {
        return;
      }
      let alreadyAssigned = false;
      for (const [, machineData] of stateMachineMap) {
        if (machineData.states.some((existing) => existing.name === s.name)) {
          alreadyAssigned = true;
          break;
        }
      }
      if (alreadyAssigned) return;
      if (s.parent) {
        for (const [machineName, machineData] of stateMachineMap) {
          if (s.parent === machineName || typeof s.parent === "string" && s.parent.includes(machineName)) {
            if (!machineData.states.some((existing) => existing.name === s.name)) {
              machineData.states.push(s);
            }
            return;
          }
        }
      }
      orphanStates.push(s);
    });
    transitions.forEach((t) => {
      for (const [, machineData] of stateMachineMap) {
        const stateIds = new Set(machineData.states.map((s) => s.id || s.name));
        if (stateIds.has(t.source) || stateIds.has(t.target)) {
          machineData.transitions.push(t);
          break;
        }
      }
    });
    const stateMachines = Array.from(stateMachineMap.entries()).map(([name, data2]) => ({
      name,
      container: data2.container,
      states: data2.states,
      transitions: data2.transitions
    }));
    if (stateMachines.length === 0 && (allStates.length > 0 || orphanStates.length > 0)) {
      stateMachines.push({
        name: "State Machine",
        container: null,
        states: allStates.filter((s) => {
          const typeLower = (s.type || "").toLowerCase();
          return !typeLower.includes("def") && !typeLower.includes("definition");
        }),
        transitions
      });
    }
    if (orphanStates.length > 0 && stateMachines.length > 0) {
      const firstMachine = stateMachines[0];
      orphanStates.forEach((s) => {
        if (!firstMachine.states.find((existing) => existing.name === s.name)) {
          firstMachine.states.push(s);
        }
      });
    }
    const machineIndex = Math.min(selectedDiagramIndex2, stateMachines.length - 1);
    const selectedMachine = stateMachines[machineIndex];
    if (!selectedMachine || selectedMachine.states.length === 0) {
      renderPlaceholder(
        width,
        height,
        "State Transition View",
        "No states found in selected state machine.\\n\\nTry selecting a different state machine from the dropdown.",
        data
      );
      return;
    }
    const states = selectedMachine.states;
    const stateMachineNames = [selectedMachine.name];
    const stateWidth = 160;
    const stateHeight = 60;
    const horizontalSpacing = 80;
    const verticalSpacing = 100;
    const marginLeft = 80;
    const marginTop = stateMachineNames.length > 0 ? 110 : 80;
    const getStateKey = (state) => state.id || state.name || "state-" + Math.random().toString(36).substr(2, 9);
    const stateUsages = states.filter((s) => {
      const typeLower = (s.type || "").toLowerCase();
      const nameLower = (s.name || "").toLowerCase();
      if (typeLower.includes("def") || typeLower.includes("definition")) {
        return false;
      }
      if (nameLower.endsWith("states") || nameLower.includes("machine")) {
        return false;
      }
      return true;
    });
    const stateKeys = new Set(stateUsages.map((s) => getStateKey(s)));
    const outgoing = /* @__PURE__ */ new Map();
    const incoming = /* @__PURE__ */ new Map();
    stateUsages.forEach((s) => {
      const key = getStateKey(s);
      outgoing.set(key, []);
      incoming.set(key, []);
    });
    const machineTransitions = selectedMachine.transitions || transitions;
    machineTransitions.forEach((t) => {
      if (stateKeys.has(t.source) && stateKeys.has(t.target)) {
        if (outgoing.has(t.source)) {
          outgoing.get(t.source).push(t.target);
        }
        if (incoming.has(t.target)) {
          incoming.get(t.target).push(t.source);
        }
      }
    });
    const initialStates = stateUsages.filter((s) => {
      const typeLower = (s.type || "").toLowerCase();
      return typeLower.includes("initial") && !typeLower.includes("state");
    });
    const finalStates = stateUsages.filter((s) => {
      const typeLower = (s.type || "").toLowerCase();
      return typeLower.includes("final") && !typeLower.includes("state");
    });
    const levels = /* @__PURE__ */ new Map();
    const visited = /* @__PURE__ */ new Set();
    const roots = stateUsages.filter((s) => {
      const key = getStateKey(s);
      const inc = incoming.get(key) || [];
      return inc.length === 0 || initialStates.includes(s);
    });
    let queue = roots.map((s) => ({ state: s, level: 0 }));
    if (queue.length === 0 && stateUsages.length > 0) {
      queue = [{ state: stateUsages[0], level: 0 }];
    }
    while (queue.length > 0) {
      const item = queue.shift();
      const { state, level } = item;
      const key = getStateKey(state);
      if (visited.has(key)) continue;
      visited.add(key);
      levels.set(key, level);
      const targets = outgoing.get(key) || [];
      targets.forEach((targetKey) => {
        const targetState = stateUsages.find((s) => getStateKey(s) === targetKey);
        if (targetState && !visited.has(targetKey)) {
          queue.push({ state: targetState, level: level + 1 });
        }
      });
    }
    stateUsages.forEach((s) => {
      const key = getStateKey(s);
      if (!visited.has(key)) {
        levels.set(key, Math.max(...Array.from(levels.values()), 0) + 1);
      }
    });
    const statesByLevel = /* @__PURE__ */ new Map();
    stateUsages.forEach((s) => {
      const key = getStateKey(s);
      const level = levels.get(key) || 0;
      if (!statesByLevel.has(level)) {
        statesByLevel.set(level, []);
      }
      statesByLevel.get(level).push(s);
    });
    const statePositions = /* @__PURE__ */ new Map();
    if (stateLayoutOrientation2 === "force") {
      const nodes = stateUsages.map((s) => ({
        id: getStateKey(s),
        state: s,
        x: marginLeft + Math.random() * (width - marginLeft * 2 - stateWidth),
        y: marginTop + Math.random() * (height - marginTop * 2 - stateHeight)
      }));
      const nodeMap = /* @__PURE__ */ new Map();
      nodes.forEach((n) => nodeMap.set(n.id, n));
      const links = [];
      machineTransitions.forEach((t) => {
        const sourceKey = t.sourceName || t.source;
        const targetKey = t.targetName || t.target;
        if (nodeMap.has(sourceKey) && nodeMap.has(targetKey) && sourceKey !== targetKey) {
          links.push({
            source: nodeMap.get(sourceKey),
            target: nodeMap.get(targetKey)
          });
        }
      });
      const simulation = d3.forceSimulation(nodes).force("center", d3.forceCenter(width / 2 - stateWidth / 2, height / 2 - stateHeight / 2)).force("charge", d3.forceManyBody().strength(-800)).force("link", d3.forceLink(links).distance(stateWidth + horizontalSpacing).strength(0.5)).force("collide", d3.forceCollide().radius(stateWidth * 0.8)).force("x", d3.forceX(width / 2 - stateWidth / 2).strength(0.05)).force("y", d3.forceY(height / 2 - stateHeight / 2).strength(0.05));
      simulation.stop();
      for (let i = 0; i < 300; ++i) simulation.tick();
      nodes.forEach((n) => {
        statePositions.set(n.id, {
          x: Math.max(marginLeft, Math.min(width - stateWidth - marginLeft, n.x)),
          y: Math.max(marginTop, Math.min(height - stateHeight - marginTop, n.y)),
          state: n.state
        });
      });
    } else if (stateLayoutOrientation2 === "horizontal") {
      statesByLevel.forEach((statesInLevel, level) => {
        const levelX = marginLeft + level * (stateWidth + horizontalSpacing);
        const compactSpacing = 20;
        const totalHeight = statesInLevel.length * stateHeight + (statesInLevel.length - 1) * compactSpacing;
        const startY = marginTop + Math.max(0, (height - totalHeight - marginTop * 2) / 3);
        statesInLevel.forEach((state, index) => {
          const key = getStateKey(state);
          statePositions.set(key, {
            x: levelX,
            y: startY + index * (stateHeight + compactSpacing),
            state
          });
        });
      });
    } else {
      statesByLevel.forEach((statesInLevel, level) => {
        const levelY = marginTop + level * (stateHeight + verticalSpacing);
        const compactSpacing = 30;
        const totalWidth = statesInLevel.length * stateWidth + (statesInLevel.length - 1) * compactSpacing;
        const startX = marginLeft + Math.max(0, (width - totalWidth - marginLeft * 2) / 3);
        statesInLevel.forEach((state, index) => {
          const key = getStateKey(state);
          statePositions.set(key, {
            x: startX + index * (stateWidth + compactSpacing),
            y: levelY,
            state
          });
        });
      });
    }
    const defs = svg2.select("defs").empty() ? svg2.append("defs") : svg2.select("defs");
    defs.selectAll("#state-arrowhead").remove();
    defs.append("marker").attr("id", "state-arrowhead").attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", 0).attr("markerWidth", 8).attr("markerHeight", 8).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").style("fill", "var(--vscode-charts-purple)");
    const transitionGroup = g2.append("g").attr("class", "state-transitions");
    const stateGroup = g2.append("g").attr("class", "state-nodes");
    if (stateMachineNames.length > 0) {
      const titleText = stateMachineNames.length === 1 ? "State Machine: " + stateMachineNames[0] : "State Machines: " + stateMachineNames.join(", ");
      g2.append("text").attr("x", marginLeft).attr("y", 30).attr("class", "state-machine-title").style("font-size", "16px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)").style("opacity", "0.9").text(titleText);
    }
    function calculateEdgePath(sourceKey, targetKey, transitionIndex = 0, totalTransitions = 1) {
      const sourcePos = statePositions.get(sourceKey);
      const targetPos = statePositions.get(targetKey);
      if (!sourcePos || !targetPos) return null;
      const sx = sourcePos.x;
      const sy = sourcePos.y;
      const tx = targetPos.x;
      const ty = targetPos.y;
      if (sourceKey === targetKey) {
        const loopSize = 30;
        return {
          path: "M " + (sx + stateWidth) + " " + (sy + stateHeight / 2) + " C " + (sx + stateWidth + loopSize) + " " + (sy + stateHeight / 2 - loopSize) + ", " + (sx + stateWidth + loopSize) + " " + (sy + stateHeight / 2 + loopSize) + ", " + (sx + stateWidth) + " " + (sy + stateHeight / 2 + 5),
          labelX: sx + stateWidth + loopSize + 5,
          labelY: sy + stateHeight / 2
        };
      }
      let startX, startY, endX, endY;
      const dx = tx - sx;
      const dy = ty - sy;
      const offset = (transitionIndex - (totalTransitions - 1) / 2) * 15;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) {
          startX = sx + stateWidth;
          startY = sy + stateHeight / 2 + offset;
          endX = tx;
          endY = ty + stateHeight / 2 + offset;
        } else {
          startX = sx;
          startY = sy + stateHeight / 2 + offset;
          endX = tx + stateWidth;
          endY = ty + stateHeight / 2 + offset;
        }
      } else {
        if (dy > 0) {
          startX = sx + stateWidth / 2 + offset;
          startY = sy + stateHeight;
          endX = tx + stateWidth / 2 + offset;
          endY = ty;
        } else {
          startX = sx + stateWidth / 2 + offset;
          startY = sy;
          endX = tx + stateWidth / 2 + offset;
          endY = ty + stateHeight;
        }
      }
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      const curveOffset = offset * 0.5;
      const controlX = midX + curveOffset;
      const controlY = midY + curveOffset;
      return {
        path: "M " + startX + " " + startY + " Q " + controlX + " " + controlY + " " + endX + " " + endY,
        labelX: controlX,
        labelY: controlY - 8
      };
    }
    function drawTransitions() {
      transitionGroup.selectAll("*").remove();
      const transitionPairs = /* @__PURE__ */ new Map();
      machineTransitions.forEach((t) => {
        const pairKey = t.source + "->" + t.target;
        if (!transitionPairs.has(pairKey)) {
          transitionPairs.set(pairKey, []);
        }
        transitionPairs.get(pairKey).push(t);
      });
      transitionPairs.forEach((transitionsForPair) => {
        transitionsForPair.forEach((transition, index) => {
          const edgeData = calculateEdgePath(
            transition.source,
            transition.target,
            index,
            transitionsForPair.length
          );
          if (!edgeData) return;
          transitionGroup.append("path").attr("d", edgeData.path).attr("class", "transition-path").style("fill", "none").style("stroke", "var(--vscode-charts-purple)").style("stroke-width", "2px").style("marker-end", "url(#state-arrowhead)");
          if (transition.label) {
            const labelText = transition.label.length > 15 ? transition.label.substring(0, 12) + "..." : transition.label;
            transitionGroup.append("rect").attr("x", edgeData.labelX - 25).attr("y", edgeData.labelY - 10).attr("width", 50).attr("height", 14).attr("rx", 3).style("fill", "var(--vscode-editor-background)").style("opacity", 0.9);
            transitionGroup.append("text").attr("x", edgeData.labelX).attr("y", edgeData.labelY).attr("text-anchor", "middle").attr("dominant-baseline", "middle").text(labelText).style("font-size", "10px").style("fill", "var(--vscode-charts-purple)").style("font-weight", "500");
          }
        });
      });
    }
    drawTransitions();
    statePositions.forEach((pos, stateKey) => {
      const state = pos.state;
      const isInitial = initialStates.includes(state);
      const isFinal = finalStates.includes(state);
      const stateElement = stateGroup.append("g").attr("class", "state-node").attr("data-state-key", stateKey).attr("transform", "translate(" + pos.x + ", " + pos.y + ")").style("cursor", "grab");
      const drag = d3.drag().on("start", function() {
        d3.select(this).raise().style("cursor", "grabbing");
      }).on("drag", function(event) {
        const newX = pos.x + event.dx;
        const newY = pos.y + event.dy;
        pos.x = newX;
        pos.y = newY;
        d3.select(this).attr("transform", "translate(" + newX + ", " + newY + ")");
        drawTransitions();
      }).on("end", function() {
        d3.select(this).style("cursor", "grab");
      });
      stateElement.call(drag);
      if (isInitial) {
        stateElement.append("circle").attr("cx", stateWidth / 2).attr("cy", stateHeight / 2).attr("r", 15).style("fill", "var(--vscode-charts-green)").style("stroke", "var(--vscode-panel-border)").style("stroke-width", "2px");
        stateElement.append("text").attr("x", stateWidth / 2).attr("y", stateHeight / 2 + 30).attr("text-anchor", "middle").text(state.name).style("font-size", "11px").style("fill", "var(--vscode-editor-foreground)");
      } else if (isFinal) {
        stateElement.append("circle").attr("cx", stateWidth / 2).attr("cy", stateHeight / 2).attr("r", 18).style("fill", "none").style("stroke", "var(--vscode-charts-red)").style("stroke-width", "2px");
        stateElement.append("circle").attr("cx", stateWidth / 2).attr("cy", stateHeight / 2).attr("r", 12).style("fill", "var(--vscode-charts-red)");
        stateElement.append("text").attr("x", stateWidth / 2).attr("y", stateHeight / 2 + 30).attr("text-anchor", "middle").text(state.name).style("font-size", "11px").style("fill", "var(--vscode-editor-foreground)");
      } else {
        const gradient = defs.append("linearGradient").attr("id", "state-gradient-" + stateKey.replace(/[^a-zA-Z0-9]/g, "_")).attr("x1", "0%").attr("y1", "0%").attr("x2", "0%").attr("y2", "100%");
        gradient.append("stop").attr("offset", "0%").style("stop-color", "var(--vscode-editor-background)");
        gradient.append("stop").attr("offset", "100%").style("stop-color", "var(--vscode-editorWidget-background)");
        stateElement.append("rect").attr("width", stateWidth).attr("height", stateHeight).attr("rx", 8).attr("ry", 8).style("fill", "url(#state-gradient-" + stateKey.replace(/[^a-zA-Z0-9]/g, "_") + ")").style("stroke", "var(--vscode-charts-blue)").style("stroke-width", "2px").style("filter", "drop-shadow(2px 2px 3px rgba(0,0,0,0.2))");
        const displayName = state.name.length > 18 ? state.name.substring(0, 15) + "..." : state.name;
        stateElement.append("text").attr("class", "node-name-text").attr("data-element-name", state.name).attr("x", stateWidth / 2).attr("y", stateHeight / 2 + 4).attr("text-anchor", "middle").text(displayName).style("font-size", "12px").style("font-weight", "600").style("fill", "var(--vscode-editor-foreground)").style("pointer-events", "none");
        stateElement.style("cursor", "pointer");
        stateElement.on("click", function(event) {
          event.stopPropagation();
          postMessage({
            command: "jumpToElement",
            elementName: state.name
          });
        }).on("dblclick", function(event) {
          event.stopPropagation();
          onStartInlineEdit(d3.select(this), state.name, pos.x, pos.y, stateWidth);
        });
      }
    });
  }

  // src/visualization/webview/elk.ts
  function renderSysMLView(ctx, width, height, data) {
    ctx.setSysMLToolbarVisible(true);
    const container = document.getElementById("visualization");
    if (!container) {
      return;
    }
    container.innerHTML = "";
    const cyContainer = document.createElement("div");
    cyContainer.id = "sysml-cytoscape";
    cyContainer.style.width = "100%";
    cyContainer.style.height = "100%";
    cyContainer.style.position = "absolute";
    cyContainer.style.top = "0";
    cyContainer.style.left = "0";
    container.appendChild(cyContainer);
    const useHierarchicalNesting = ctx.sysmlMode === "hierarchy";
    const graph = ctx.buildSysMLGraph(data, void 0, useHierarchicalNesting);
    ctx.setLastPillarStats(graph.stats);
    ctx.renderPillarChips(graph.stats);
    const existingCy = ctx.getCy();
    if (existingCy) {
      existingCy.destroy();
    }
    const cy2 = cytoscape({
      container: cyContainer,
      elements: graph.elements,
      style: ctx.getSysMLStyles(),
      minZoom: MIN_SYSML_ZOOM,
      maxZoom: MAX_SYSML_ZOOM,
      wheelSensitivity: 1,
      boxSelectionEnabled: false,
      autounselectify: true
    });
    ctx.setCy(cy2);
    cy2.on("zoom", () => {
      window.userHasManuallyZoomed = true;
    });
    let tapTimeout = null;
    let lastTapped = null;
    cy2.on("tap", 'node[type = "pillar"]', (event) => {
      const id = event.target.data("pillar");
      ctx.togglePillarExpansion(id);
    });
    cy2.on("tap", 'node[type = "element"]', (event) => {
      const node = event.target;
      cy2.elements().removeClass("highlighted-sysml");
      node.addClass("highlighted-sysml");
      const pillarLabel = ctx.SYSML_PILLARS.find((p) => p.id === node.data("pillar"))?.label || "Element";
      const statusEl = document.getElementById("status-text");
      if (statusEl) statusEl.textContent = pillarLabel + ": " + node.data("label") + " [" + node.data("sysmlType") + "]";
      ctx.centerOnNode(node);
      if (tapTimeout && lastTapped === node.id()) {
        clearTimeout(tapTimeout);
        tapTimeout = null;
        lastTapped = null;
        const elementNameToJump = node.data("elementName");
        ctx.postMessage({
          command: "jumpToElement",
          elementName: elementNameToJump
        });
      } else {
        lastTapped = node.id();
        tapTimeout = setTimeout(() => {
          tapTimeout = null;
          lastTapped = null;
        }, 250);
      }
    });
    ctx.updatePillarVisibility();
    cy2.resize();
    cy2.forceRender();
    setTimeout(() => {
      ctx.runSysMLLayout(true);
      if (!ctx.isSequentialBehaviorContext()) {
        const statusEl = document.getElementById("status-text");
        if (statusEl) statusEl.textContent = "SysML Pillar View \u2022 Tap a pillar to expand/collapse";
      }
    }, 100);
  }

  // src/visualization/webview/renderers/sysmlNodeBuilder.ts
  var DEFAULT_CONFIG = {
    showHeader: true,
    showAttributes: true,
    showParts: true,
    showPorts: true,
    showOther: true,
    maxLinesPerCompartment: 8
  };
  var LINE_HEIGHT = 12;
  var COMPARTMENT_LABEL_HEIGHT = 14;
  var COMPARTMENT_GAP = 2;
  var COMPARTMENT_PADDING = 4;
  var HEADER_COMPARTMENT_HEIGHT = 44;
  var TYPED_BY_HEIGHT = 14;
  var PADDING = 6;
  function collectCompartmentsFromElement(element) {
    const headerName = (element?.name ?? element?.elementName ?? element?.label ?? "Unnamed").toString();
    const result = {
      header: {
        stereotype: (element?.type || "element").toLowerCase(),
        name: headerName
      },
      typedByName: null,
      attributes: [],
      parts: [],
      ports: [],
      other: []
    };
    if (element) {
      const attrs = element.attributes;
      result.typedByName = attrs && (typeof attrs.get === "function" ? attrs.get("partType") || attrs.get("type") || attrs.get("typedBy") : attrs.partType || attrs.type || attrs.typedBy) || null;
      if (!result.typedByName && element.partType) result.typedByName = element.partType;
      if (!result.typedByName && element.typings?.length) {
        result.typedByName = String(element.typings[0]).replace(/^[:~]+/, "").trim();
      }
      if (!result.typedByName && element.typing) {
        result.typedByName = String(element.typing).replace(/^[:~]+/, "").trim();
      }
    }
    if (!element?.children?.length) {
      return result;
    }
    const typeLower = (element.type || "").toLowerCase();
    const isRequirement = typeLower.includes("requirement");
    element.children.forEach((child) => {
      if (!child?.name) return;
      const cType = (child.type || "").toLowerCase();
      if (cType.includes("package") || cType.includes("state")) return;
      if (cType === "attribute" || cType.includes("attribute")) {
        const dataType = child.attributes?.get ? child.attributes.get("dataType") : child.attributes?.dataType;
        const typeStr = dataType ? " : " + String(dataType).split("::").pop() : "";
        result.attributes.push("  " + child.name + typeStr);
      } else if (cType === "port" || cType.includes("port")) {
        const portType = child.attributes?.get ? child.attributes.get("portType") : child.attributes?.portType;
        const pTypeStr = portType ? " : " + portType : "";
        result.ports.push("  " + child.name + pTypeStr);
      } else if (cType.includes("part")) {
        result.parts.push("  " + child.name);
      } else if (cType.includes("action")) {
        const existing = result.other.find((o) => o.title === "Actions");
        if (existing) existing.lines.push("  " + child.name);
        else result.other.push({ title: "Actions", lines: ["  " + child.name] });
      } else if (cType.includes("requirement") || cType.includes("interface") || cType.includes("connect")) {
        const existing = result.other.find((o) => o.title === "Nested");
        if (existing) existing.lines.push("  " + child.name);
        else result.other.push({ title: "Nested", lines: ["  " + child.name] });
      }
    });
    if (element.ports?.length) {
      element.ports.forEach((p) => {
        const pName = typeof p === "string" ? p : p?.name || "port";
        if (!result.ports.some((l) => l.includes(pName))) result.ports.push("  " + pName);
      });
    }
    if (isRequirement && result.other.length) {
      result.attributes = [];
      result.parts = [];
      result.ports = [];
    }
    return result;
  }
  function computeNodeHeightFromCompartments(compartments, config, nodeWidth) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    let h = PADDING * 2;
    if (cfg.showHeader) {
      h += HEADER_COMPARTMENT_HEIGHT;
      if (compartments.typedByName) h += TYPED_BY_HEIGHT;
    }
    const hasBodyCompartments = cfg.showAttributes && compartments.attributes.length > 0 || cfg.showParts && compartments.parts.length > 0 || cfg.showPorts && compartments.ports.length > 0 || cfg.showOther && !!compartments.other?.some((s) => s.lines.length > 0);
    if (cfg.showHeader && hasBodyCompartments) {
      h += COMPARTMENT_PADDING;
    }
    const addComp = (lines) => {
      if (lines.length === 0) return;
      const n = cfg.maxLinesPerCompartment ? Math.min(lines.length, cfg.maxLinesPerCompartment) : lines.length;
      h += COMPARTMENT_PADDING * 2 + COMPARTMENT_LABEL_HEIGHT + n * LINE_HEIGHT + COMPARTMENT_GAP;
    };
    if (cfg.showAttributes) addComp(compartments.attributes);
    if (cfg.showParts) addComp(compartments.parts);
    if (cfg.showPorts) addComp(compartments.ports);
    if (cfg.showOther && compartments.other?.length) {
      compartments.other.forEach((sec) => {
        const n = cfg.maxLinesPerCompartment ? Math.min(sec.lines.length, cfg.maxLinesPerCompartment) : sec.lines.length;
        h += COMPARTMENT_PADDING * 2 + COMPARTMENT_LABEL_HEIGHT + n * LINE_HEIGHT + COMPARTMENT_GAP;
      });
    }
    return Math.max(60, h);
  }
  function renderSysMLNode(parentGroup, compartments, options) {
    const cfg = { ...DEFAULT_CONFIG, ...options.config || {} };
    const formatStereo = options.formatStereotype || ((t) => "\xAB" + t + "\xBB");
    let contentY = 0;
    const nodeG = parentGroup.append("g").attr("class", (options.nodeClass || "sysml-node") + (options.isDefinition ? " definition-node" : " usage-node")).attr("transform", "translate(" + options.x + "," + options.y + ")").attr("data-element-name", options.dataElementName || compartments.header.name).style("cursor", "pointer");
    const strokeColor = options.typeColor || "var(--vscode-charts-blue)";
    const strokeW = options.isDefinition ? "3px" : "2px";
    nodeG.append("rect").attr("width", options.width).attr("height", options.height).attr("rx", options.isDefinition ? 4 : 8).attr("class", "graph-node-background sysml-node-bg").attr("data-original-stroke", strokeColor).attr("data-original-width", strokeW).style("fill", "var(--vscode-editor-background)").style("stroke", strokeColor).style("stroke-width", strokeW).style("stroke-dasharray", options.isDefinition ? "6,3" : "none");
    if (cfg.showHeader) {
      const headerH = HEADER_COMPARTMENT_HEIGHT + (compartments.typedByName ? TYPED_BY_HEIGHT : 0);
      nodeG.append("rect").attr("y", 0).attr("width", options.width).attr("height", 5).attr("rx", 2).style("fill", strokeColor);
      nodeG.append("rect").attr("y", 5).attr("width", options.width).attr("height", headerH - 5).attr("class", "sysml-header-compartment").style("fill", "var(--vscode-button-secondaryBackground)");
      const stereo = formatStereo(compartments.header.stereotype) || "\xAB" + compartments.header.stereotype + "\xBB";
      nodeG.append("text").attr("x", options.width / 2).attr("y", 17).attr("text-anchor", "middle").text(stereo).style("font-size", "9px").style("fill", strokeColor);
      const displayName = compartments.header.name;
      const truncatedName = displayName.length > 26 ? displayName.substring(0, 24) + ".." : displayName;
      nodeG.append("text").attr("class", "node-name-text").attr("x", options.width / 2).attr("y", 31).attr("text-anchor", "middle").text(truncatedName).style("font-size", "11px").style("font-weight", "bold").style("fill", "var(--vscode-editor-foreground)");
      if (compartments.typedByName) {
        const tbText = compartments.typedByName.length > 22 ? compartments.typedByName.substring(0, 20) + ".." : compartments.typedByName;
        nodeG.append("text").attr("x", options.width / 2).attr("y", 43).attr("text-anchor", "middle").text(": " + tbText).style("font-size", "10px").style("font-style", "italic").style("fill", "#569CD6");
      }
      contentY += headerH;
      contentY += COMPARTMENT_PADDING;
    }
    const renderCompartment = (title, lines) => {
      if (lines.length === 0) return;
      const limit = cfg.maxLinesPerCompartment ? Math.min(lines.length, cfg.maxLinesPerCompartment) : lines.length;
      const slice = lines.slice(0, limit);
      const compTop = contentY;
      nodeG.append("line").attr("x1", PADDING).attr("y1", compTop).attr("x2", options.width - PADDING).attr("y2", compTop).attr("class", "sysml-compartment-divider").style("stroke", "var(--vscode-panel-border)").style("stroke-width", "1px");
      contentY += 4;
      nodeG.append("text").attr("x", PADDING).attr("y", contentY + 9).text(title).style("font-size", "9px").style("font-weight", "bold").style("fill", "var(--vscode-descriptionForeground)");
      contentY += COMPARTMENT_LABEL_HEIGHT;
      slice.forEach((line) => {
        const truncated = line.length > 28 ? line.substring(0, 26) + ".." : line;
        nodeG.append("text").attr("x", PADDING).attr("y", contentY + 9).text(truncated).style("font-size", "9px").style("fill", "var(--vscode-descriptionForeground)");
        contentY += LINE_HEIGHT;
      });
      contentY += COMPARTMENT_PADDING;
      contentY += COMPARTMENT_GAP;
    };
    if (cfg.showAttributes && compartments.attributes.length > 0) {
      renderCompartment("Attributes", compartments.attributes);
    }
    if (cfg.showParts && compartments.parts.length > 0) {
      renderCompartment("Parts", compartments.parts);
    }
    if (cfg.showPorts && compartments.ports.length > 0) {
      renderCompartment("Ports", compartments.ports);
    }
    if (cfg.showOther && compartments.other?.length) {
      compartments.other.forEach((sec) => {
        if (sec.lines.length > 0) renderCompartment(sec.title, sec.lines);
      });
    }
    return nodeG;
  }

  // src/visualization/webview/renderers/generalView.ts
  var NODE_WIDTH = 200;
  var NODE_HEIGHT_BASE = 70;
  var GENERAL_VIEW_NODE_CONFIG = {
    showHeader: true,
    showAttributes: true,
    showParts: true,
    showPorts: true,
    showOther: true,
    maxLinesPerCompartment: 8
  };
  function computeOrthogonalPath(x1, y1, x2, y2, options = {}) {
    const offset = options.offset ?? 0;
    const srcRect = options.srcRect;
    const tgtRect = options.tgtRect;
    const srcCx = srcRect ? srcRect.x + srcRect.width / 2 : x1;
    const srcCy = srcRect ? srcRect.y + srcRect.height / 2 : y1;
    const tgtCx = tgtRect ? tgtRect.x + tgtRect.width / 2 : x2;
    const tgtCy = tgtRect ? tgtRect.y + tgtRect.height / 2 : y2;
    const dx = tgtCx - srcCx;
    const dy = tgtCy - srcCy;
    let ox1 = x1, oy1 = y1, ox2 = x2, oy2 = y2;
    if (srcRect) {
      if (Math.abs(dx) > Math.abs(dy)) {
        ox1 = dx > 0 ? srcRect.x + srcRect.width : srcRect.x;
        oy1 = srcCy + offset;
      } else {
        ox1 = srcCx + offset;
        oy1 = dy > 0 ? srcRect.y + srcRect.height : srcRect.y;
      }
    }
    if (tgtRect) {
      if (Math.abs(dx) > Math.abs(dy)) {
        ox2 = dx > 0 ? tgtRect.x : tgtRect.x + tgtRect.width;
        oy2 = tgtCy + offset;
      } else {
        ox2 = tgtCx + offset;
        oy2 = dy > 0 ? tgtRect.y : tgtRect.y + tgtRect.height;
      }
    }
    const distX = Math.abs(ox2 - ox1);
    const distY = Math.abs(oy2 - oy1);
    const wpSpread = offset * 0.4;
    let pathD;
    let labelX, labelY;
    if (distX > distY) {
      const midX = (ox1 + ox2) / 2 + wpSpread;
      pathD = "M" + ox1 + "," + oy1 + " L" + midX + "," + oy1 + " L" + midX + "," + oy2 + " L" + ox2 + "," + oy2;
      labelX = midX;
      labelY = (oy1 + oy2) / 2 - 8 + offset * 0.5;
    } else {
      const midY = (oy1 + oy2) / 2 + wpSpread;
      pathD = "M" + ox1 + "," + oy1 + " L" + ox1 + "," + midY + " L" + ox2 + "," + midY + " L" + ox2 + "," + oy2;
      labelX = (ox1 + ox2) / 2 + offset * 0.5;
      labelY = midY - 8;
    }
    return { pathD, labelX, labelY };
  }
  function pathFromElkSections(sections) {
    if (!sections || sections.length === 0) return null;
    const parts = [];
    for (const sec of sections) {
      const sp = sec.startPoint;
      const ep = sec.endPoint;
      const bp = sec.bendPoints || [];
      if (!sp || !ep) return null;
      parts.push("M" + sp.x + "," + sp.y);
      for (const p of bp) {
        parts.push("L" + p.x + "," + p.y);
      }
      parts.push("L" + ep.x + "," + ep.y);
    }
    return parts.join(" ");
  }
  async function renderGeneralViewD3(ctx, data) {
    const { width, height, svg: svg2, g: g2, postMessage, renderPlaceholder, clearVisualHighlights: clearVisualHighlights2 } = ctx;
    const result = ctx.buildGeneralViewGraph(data);
    const { elements, typeStats } = result;
    ctx.renderGeneralChips(typeStats);
    const cyNodes = elements.filter((el) => el.group === "nodes");
    const cyEdges = elements.filter((el) => el.group === "edges");
    if (cyNodes.length === 0) {
      renderPlaceholder(
        width,
        height,
        "General View",
        "No matching elements to display.\\n\\nTry enabling more categories using the filter chips above.",
        data
      );
      return;
    }
    if (typeof ELK === "undefined") {
      renderPlaceholder(
        width,
        height,
        "General View",
        "ELK layout library not loaded. Please refresh the view.",
        data
      );
      return;
    }
    let elk;
    try {
      elk = new ELK({ workerUrl: ctx.elkWorkerUrl || void 0 });
    } catch (e) {
      console.warn("[General View] ELK worker init failed, layout may be unavailable:", e);
    }
    const nodeWidth = NODE_WIDTH;
    const nodeDataMap = /* @__PURE__ */ new Map();
    cyNodes.forEach((el) => {
      const element = el.data.element;
      const compartments = element ? collectCompartmentsFromElement(element) : {
        header: { stereotype: "element", name: "Unnamed" },
        typedByName: null,
        attributes: [],
        parts: [],
        ports: [],
        other: []
      };
      const nodeHeight = computeNodeHeightFromCompartments(compartments, GENERAL_VIEW_NODE_CONFIG, NODE_WIDTH);
      nodeDataMap.set(el.data.id, { compartments, height: Math.max(NODE_HEIGHT_BASE, nodeHeight) });
    });
    const elkGraph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "220",
        "elk.layered.spacing.nodeNodeBetweenLayers": "280",
        "elk.spacing.edgeNode": "120",
        "elk.spacing.edgeEdge": "120",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.separateConnectedComponents": "true",
        "elk.aspectRatio": "1.4",
        "elk.padding": "[top=100,left=100,bottom=100,right=100]",
        "org.eclipse.elk.portConstraints": "FIXED_SIDE",
        "org.eclipse.elk.json.edgeCoords": "ROOT"
      },
      children: cyNodes.map((el) => {
        const nd = nodeDataMap.get(el.data.id);
        const nodeHeight = nd?.height ?? NODE_HEIGHT_BASE;
        return {
          id: el.data.id,
          width: nodeWidth,
          height: nodeHeight,
          ports: [
            { id: el.data.id + "_south", layoutOptions: { "org.eclipse.elk.port.side": "SOUTH" } },
            { id: el.data.id + "_north", layoutOptions: { "org.eclipse.elk.port.side": "NORTH" } }
          ]
        };
      }),
      edges: cyEdges.map((el, idx) => ({
        id: el.data.id || "edge-" + idx,
        sources: [el.data.source + "_south"],
        targets: [el.data.target + "_north"]
      }))
    };
    let laidOut;
    try {
      laidOut = elk ? await elk.layout(elkGraph) : null;
    } catch (e) {
      console.error("[General View] ELK layout failed:", e);
    }
    const nodePositions = /* @__PURE__ */ new Map();
    if (laidOut && laidOut.children) {
      laidOut.children.forEach((child) => {
        const nd = nodeDataMap.get(child.id);
        nodePositions.set(child.id, {
          x: child.x ?? 0,
          y: child.y ?? 0,
          width: child.width ?? nodeWidth,
          height: child.height ?? nd?.height ?? NODE_HEIGHT_BASE
        });
      });
    } else {
      let x = 80, y = 80;
      cyNodes.forEach((el, i) => {
        const nd = nodeDataMap.get(el.data.id);
        const h = nd?.height ?? NODE_HEIGHT_BASE;
        nodePositions.set(el.data.id, { x, y, width: nodeWidth, height: h });
        x += nodeWidth + 60;
        if (x > width - nodeWidth - 80) {
          x = 80;
          y += h + 80;
        }
      });
    }
    g2.selectAll("*").remove();
    const defs = svg2.select("defs").empty() ? svg2.append("defs") : svg2.select("defs");
    defs.selectAll("#general-d3-arrow").remove();
    defs.append("marker").attr("id", "general-d3-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 8).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").style("fill", "var(--vscode-charts-blue)");
    defs.selectAll("#general-d3-specializes").remove();
    defs.append("marker").attr("id", "general-d3-specializes").attr("viewBox", "0 -6 12 12").attr("refX", 11).attr("refY", 0).attr("markerWidth", 8).attr("markerHeight", 8).attr("orient", "auto").append("path").attr("d", "M0,0L10,-4L10,4Z").style("fill", GENERAL_VIEW_PALETTE.structural.port);
    const edgeGroup = g2.append("g").attr("class", "general-edges");
    const nodeGroup = g2.append("g").attr("class", "general-nodes");
    const laidOutEdges = laidOut?.edges ?? [];
    const typingByTarget = /* @__PURE__ */ new Map();
    cyEdges.forEach((el, idx) => {
      const t = (el.data.type || el.data.relType || "").toLowerCase();
      if (t === "typing") {
        const tgt = el.data.target;
        if (!typingByTarget.has(tgt)) typingByTarget.set(tgt, []);
        typingByTarget.get(tgt).push({ el, idx });
      }
    });
    cyEdges.forEach((el, edgeIdx) => {
      const srcPos = nodePositions.get(el.data.source);
      const tgtPos = nodePositions.get(el.data.target);
      if (!srcPos || !tgtPos) return;
      const relType = (el.data.relType || el.data.type || "relationship").toLowerCase();
      const elkEdge = laidOutEdges[edgeIdx];
      let pathD;
      if (elkEdge?.sections) {
        const elkPath = pathFromElkSections(elkEdge.sections);
        pathD = elkPath ?? computeOrthogonalPath(0, 0, 0, 0, {
          srcRect: { x: srcPos.x, y: srcPos.y, width: srcPos.width, height: srcPos.height },
          tgtRect: { x: tgtPos.x, y: tgtPos.y, width: tgtPos.width, height: tgtPos.height }
        }).pathD;
      } else {
        let offset = 0;
        if (relType === "typing") {
          const group = typingByTarget.get(el.data.target) || [];
          const rank = group.findIndex((x) => x.el === el);
          if (rank >= 0 && group.length > 1) {
            offset = (rank - (group.length - 1) / 2) * 18;
          }
        }
        const { pathD: fallbackPath } = computeOrthogonalPath(0, 0, 0, 0, {
          srcRect: { x: srcPos.x, y: srcPos.y, width: srcPos.width, height: srcPos.height },
          tgtRect: { x: tgtPos.x, y: tgtPos.y, width: tgtPos.width, height: tgtPos.height },
          offset
        });
        pathD = fallbackPath;
      }
      let strokeColor = GENERAL_VIEW_PALETTE.other.default;
      let strokeDash = "none";
      let markerEnd = "url(#general-d3-arrow)";
      let strokeWidth = "2px";
      if (relType === "specializes") {
        strokeColor = GENERAL_VIEW_PALETTE.structural.port;
        markerEnd = "url(#general-d3-specializes)";
      } else if (relType === "typing") {
        strokeColor = GENERAL_VIEW_PALETTE.requirements.requirement;
        strokeDash = "5,3";
      } else if (relType === "hierarchy" || relType === "contains") {
        strokeColor = GENERAL_VIEW_PALETTE.structural.part;
      } else if (relType === "connection" || relType === "connect") {
        strokeColor = GENERAL_VIEW_PALETTE.structural.interface;
      } else if (relType === "bind" || relType === "binding") {
        strokeColor = "#808080";
        strokeDash = "2,2";
        markerEnd = "none";
      } else if (relType === "allocate" || relType === "allocation") {
        strokeColor = GENERAL_VIEW_PALETTE.other.allocation;
        strokeDash = "8,4";
      }
      edgeGroup.append("path").attr("d", pathD).attr("class", "general-connector").attr("data-source", el.data.source).attr("data-target", el.data.target).attr("data-type", relType).style("fill", "none").style("stroke", strokeColor).style("stroke-width", strokeWidth).style("stroke-dasharray", strokeDash).style("opacity", 0.85).style("marker-end", markerEnd).style("cursor", "pointer");
    });
    const statusEl = document.getElementById("status-text");
    if (statusEl) statusEl.textContent = "General View \u2022 Tap element to highlight, double-tap to jump";
    let lastTappedId = null;
    let tapTimeout = null;
    cyNodes.forEach((el) => {
      const pos = nodePositions.get(el.data.id);
      if (!pos) return;
      const d = el.data;
      const nd = nodeDataMap.get(d.id);
      const compartments = nd?.compartments ?? {
        header: { stereotype: (d.sysmlType || "element").toLowerCase(), name: (d.elementName || d.label || "Unnamed").toString() },
        typedByName: null,
        attributes: [],
        parts: [],
        ports: [],
        other: []
      };
      const isDefinition = d.isDefinition === true;
      const typeColor = d.color || getTypeColor(d.sysmlType);
      const nodeG = renderSysMLNode(nodeGroup, compartments, {
        x: pos.x,
        y: pos.y,
        width: pos.width,
        height: pos.height,
        config: GENERAL_VIEW_NODE_CONFIG,
        isDefinition,
        typeColor,
        formatStereotype: (t) => formatSysMLStereotype(t) || "\xAB" + t + "\xBB",
        nodeClass: "general-node elk-node",
        dataElementName: d.elementName || d.label
      });
      nodeG.on("click", function(event) {
        event.stopPropagation();
        clearVisualHighlights2();
        g2.selectAll(".general-node").select(".graph-node-background").each(function() {
          const r = d3.select(this);
          r.style("stroke", r.attr("data-original-stroke")).style("stroke-width", r.attr("data-original-width"));
        });
        nodeG.select(".graph-node-background").style("stroke", "#FFD700").style("stroke-width", "4px");
        const statusEl2 = document.getElementById("status-text");
        if (statusEl2) statusEl2.textContent = (d.label || d.elementName) + " [" + (d.sysmlType || "element") + "]";
        const elementName = d.elementName;
        const nodeId = d.id;
        if (elementName) {
          if (lastTappedId === nodeId && tapTimeout) {
            clearTimeout(tapTimeout);
            tapTimeout = null;
            lastTappedId = null;
            postMessage({ command: "jumpToElement", elementName });
          } else {
            lastTappedId = nodeId;
            tapTimeout = setTimeout(() => {
              tapTimeout = null;
              lastTappedId = null;
            }, 250);
          }
        }
      });
    });
  }

  // src/visualization/webview/export.ts
  function prepareSvgForExport(svgElement) {
    if (!svgElement) return null;
    const clonedSvg = svgElement.cloneNode(true);
    const bgColor = getComputedStyle(document.body).backgroundColor || "#1e1e1e";
    const originalG = svgElement.querySelector("g");
    let contentBounds = null;
    if (originalG) {
      try {
        contentBounds = originalG.getBBox();
      } catch (e) {
        console.warn("Could not get content bounds");
      }
    }
    let fullWidth;
    let fullHeight;
    const padding = 20;
    if (contentBounds && contentBounds.width > 0) {
      fullWidth = Math.max(contentBounds.x + contentBounds.width + padding, svgElement.clientWidth);
      fullHeight = Math.max(contentBounds.y + contentBounds.height + padding, svgElement.clientHeight);
    } else {
      fullWidth = svgElement.width?.baseVal?.value || svgElement.clientWidth || 800;
      fullHeight = svgElement.height?.baseVal?.value || svgElement.clientHeight || 600;
    }
    clonedSvg.setAttribute("width", fullWidth.toString());
    clonedSvg.setAttribute("height", fullHeight.toString());
    clonedSvg.setAttribute("viewBox", "0 0 " + fullWidth + " " + fullHeight);
    const clonedG = clonedSvg.querySelector("g");
    if (clonedG && clonedG.hasAttribute("transform")) {
      clonedG.removeAttribute("transform");
    }
    const elements = clonedSvg.querySelectorAll("*");
    const originalElements = svgElement.querySelectorAll("*");
    elements.forEach((el, index) => {
      const origEl = originalElements[index];
      if (!origEl) return;
      try {
        const tagName = el.tagName.toLowerCase();
        const computedStyle = window.getComputedStyle(origEl);
        if (tagName === "path") {
          const stroke = computedStyle.getPropertyValue("stroke");
          const strokeWidth = computedStyle.getPropertyValue("stroke-width");
          const fill = computedStyle.getPropertyValue("fill");
          const opacity = computedStyle.getPropertyValue("opacity");
          const strokeDasharray = computedStyle.getPropertyValue("stroke-dasharray");
          let inlineStyle = "";
          if (stroke && stroke !== "none") inlineStyle += "stroke: " + stroke + "; ";
          if (strokeWidth) inlineStyle += "stroke-width: " + strokeWidth + "; ";
          if (fill) inlineStyle += "fill: " + fill + "; ";
          if (opacity && opacity !== "1") inlineStyle += "opacity: " + opacity + "; ";
          if (strokeDasharray && strokeDasharray !== "none") inlineStyle += "stroke-dasharray: " + strokeDasharray + "; ";
          if (inlineStyle) {
            el.setAttribute("style", inlineStyle);
          }
        }
        if (tagName === "line") {
          const stroke = computedStyle.getPropertyValue("stroke");
          const strokeWidth = computedStyle.getPropertyValue("stroke-width");
          const strokeDasharray = computedStyle.getPropertyValue("stroke-dasharray");
          let inlineStyle = "";
          if (stroke && stroke !== "none") inlineStyle += "stroke: " + stroke + "; ";
          if (strokeWidth) inlineStyle += "stroke-width: " + strokeWidth + "; ";
          if (strokeDasharray && strokeDasharray !== "none") inlineStyle += "stroke-dasharray: " + strokeDasharray + "; ";
          if (inlineStyle) {
            el.setAttribute("style", inlineStyle);
          }
        }
        if (tagName === "circle") {
          const stroke = computedStyle.getPropertyValue("stroke");
          const strokeWidth = computedStyle.getPropertyValue("stroke-width");
          const fill = computedStyle.getPropertyValue("fill");
          let inlineStyle = "";
          if (stroke && stroke !== "none") inlineStyle += "stroke: " + stroke + "; ";
          if (strokeWidth) inlineStyle += "stroke-width: " + strokeWidth + "; ";
          if (fill) inlineStyle += "fill: " + fill + "; ";
          if (inlineStyle) {
            el.setAttribute("style", inlineStyle);
          }
        }
        if (tagName === "text") {
          const fill = computedStyle.getPropertyValue("fill") || computedStyle.getPropertyValue("color");
          const fontSize = computedStyle.getPropertyValue("font-size");
          const fontFamily = computedStyle.getPropertyValue("font-family");
          const fontWeight = computedStyle.getPropertyValue("font-weight");
          let inlineStyle = el.getAttribute("style") || "";
          if (fill && !inlineStyle.includes("fill:")) inlineStyle += "fill: " + fill + "; ";
          if (fontSize && !inlineStyle.includes("font-size:")) inlineStyle += "font-size: " + fontSize + "; ";
          if (fontFamily && !inlineStyle.includes("font-family:")) inlineStyle += "font-family: " + fontFamily + "; ";
          if (fontWeight && !inlineStyle.includes("font-weight:")) inlineStyle += "font-weight: " + fontWeight + "; ";
          if (inlineStyle) {
            el.setAttribute("style", inlineStyle);
          }
        }
        const existingStyle = el.getAttribute("style") || "";
        if (existingStyle.includes("var(")) {
          const styleProps = existingStyle.split(";").filter((s) => s.trim());
          const resolvedProps = styleProps.map((prop) => {
            const colonIdx = prop.indexOf(":");
            if (colonIdx === -1) return prop.trim();
            const name = prop.substring(0, colonIdx).trim();
            const value = prop.substring(colonIdx + 1).trim();
            if (value && value.includes("var(")) {
              const computed = computedStyle.getPropertyValue(name);
              if (computed) {
                return name + ": " + computed;
              }
            }
            return prop.trim();
          });
          el.setAttribute("style", resolvedProps.join("; ") + ";");
        }
        if (tagName === "rect") {
          const stroke = computedStyle.getPropertyValue("stroke");
          const fill = computedStyle.getPropertyValue("fill");
          const strokeWidth = computedStyle.getPropertyValue("stroke-width");
          let currentStyle = el.getAttribute("style") || "";
          if (stroke && stroke !== "none" && !currentStyle.includes("stroke:")) {
            currentStyle += "stroke: " + stroke + "; ";
          }
          if (strokeWidth && !currentStyle.includes("stroke-width:")) {
            currentStyle += "stroke-width: " + strokeWidth + "; ";
          }
          if (fill && !currentStyle.includes("fill:")) {
            currentStyle += "fill: " + fill + "; ";
          }
          el.setAttribute("style", currentStyle);
        }
      } catch (e) {
      }
    });
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("x", "0");
    bgRect.setAttribute("y", "0");
    bgRect.setAttribute("width", fullWidth.toString());
    bgRect.setAttribute("height", fullHeight.toString());
    bgRect.setAttribute("fill", bgColor);
    clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);
    if (!clonedSvg.hasAttribute("xmlns")) {
      clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    return clonedSvg;
  }
  function createExportHandler(opts) {
    const { getCurrentData, getViewState, postMessage } = opts;
    function exportJSON() {
      const currentData2 = getCurrentData();
      if (!currentData2) {
        console.error("No data available for JSON export");
        return;
      }
      const jsonData = JSON.stringify(currentData2, null, 2);
      const blob = new Blob([jsonData], { type: "application/json" });
      const reader = new FileReader();
      reader.onloadend = function() {
        postMessage({
          command: "export",
          format: "json",
          data: reader.result
        });
      };
      reader.readAsDataURL(blob);
    }
    function exportPNG(scale) {
      const scaleFactor = scale || 2;
      const { currentView: currentView2, cy: cy2 } = getViewState();
      if (currentView2 === "sysml" && cy2) {
        const pngData = cy2.png({
          output: "base64uri",
          full: true,
          scale: scaleFactor,
          bg: getComputedStyle(document.body).backgroundColor || "#1e1e1e"
        });
        postMessage({
          command: "export",
          format: "png",
          data: pngData
        });
        return;
      }
      const svgElement = document.querySelector("#visualization svg");
      if (!svgElement) {
        console.error("No SVG element found for PNG export");
        return;
      }
      const preparedSvg = prepareSvgForExport(svgElement);
      if (!preparedSvg) {
        console.error("Failed to prepare SVG for export");
        return;
      }
      const svgData = new XMLSerializer().serializeToString(preparedSvg);
      const width = parseInt(preparedSvg.getAttribute("width") || "800", 10);
      const height = parseInt(preparedSvg.getAttribute("height") || "600", 10);
      const canvas = document.createElement("canvas");
      canvas.width = width * scaleFactor;
      canvas.height = height * scaleFactor;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(scaleFactor, scaleFactor);
      const img = new Image();
      img.onload = function() {
        ctx.drawImage(img, 0, 0, width, height);
        const pngData = canvas.toDataURL("image/png");
        postMessage({
          command: "export",
          format: "png",
          data: pngData
        });
      };
      img.onerror = function() {
        console.error("Failed to load SVG image for PNG export");
      };
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
    }
    function exportSVG() {
      const svgString = getSvgStringForExport();
      if (!svgString) {
        const { currentView: currentView2, cy: cy2 } = getViewState();
        if (currentView2 === "sysml" && cy2) {
          exportPNG();
        } else {
          console.error("No SVG available for export");
        }
        return;
      }
      const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const reader = new FileReader();
      reader.onloadend = function() {
        postMessage({
          command: "export",
          format: "svg",
          data: reader.result
        });
      };
      reader.readAsDataURL(svgBlob);
    }
    function getSvgStringForExport() {
      const { currentView: currentView2, cy: cy2 } = getViewState();
      if (currentView2 === "sysml" && cy2) {
        if (typeof cy2.svg === "function") {
          return cy2.svg({ scale: 1, full: true });
        }
        return null;
      }
      const svgElement = document.querySelector("#visualization svg");
      if (!svgElement) return null;
      const preparedSvg = prepareSvgForExport(svgElement);
      if (!preparedSvg) return null;
      return new XMLSerializer().serializeToString(preparedSvg);
    }
    return {
      exportJSON,
      exportPNG,
      exportSVG,
      prepareSvgForExport,
      getSvgStringForExport
    };
  }

  // src/visualization/webview/orchestrator.ts
  var vscode;
  function initializeOrchestrator(api) {
    vscode = api;
    vscode.postMessage({ command: "webviewReady" });
  }
  var elkWorkerUrl = (typeof window !== "undefined" && window.__VIZ_INIT?.elkWorkerUrl) ?? "";
  var currentData = null;
  var currentView = "general-view";
  var selectedDiagramIndex = 0;
  var selectedDiagramName = null;
  var selectedIbdRoot = null;
  var activityDebugLabels = false;
  var lastView = currentView;
  var svg = null;
  var g = null;
  var zoom = null;
  var cy = null;
  var sysmlMode = "hierarchy";
  var layoutDirection = "horizontal";
  var activityLayoutDirection = "vertical";
  var stateLayoutOrientation = "horizontal";
  var filteredData = null;
  var isRendering = false;
  var showMetadata = false;
  var showCategoryHeaders = true;
  var sysmlElementLookup = /* @__PURE__ */ new Map();
  var SYSML_PILLARS = [
    { id: "structure", label: "Structure", keywords: ["part", "port", "attribute", "item", "interface", "package", "allocation", "constraint"] },
    { id: "behavior", label: "Behavior", keywords: ["action", "state", "activity", "calc", "enumeration"] },
    { id: "requirement", label: "Requirements", keywords: ["requirement", "req"] },
    { id: "usecases", label: "Use Cases", keywords: ["use case", "usecase"] }
  ];
  var PILLAR_COLOR_MAP = {
    structure: GENERAL_VIEW_PALETTE.structural.part,
    behavior: GENERAL_VIEW_PALETTE.behavior.action,
    requirement: GENERAL_VIEW_PALETTE.requirements.requirement,
    usecases: GENERAL_VIEW_PALETTE.requirements.useCase
  };
  var expandedPillars = /* @__PURE__ */ new Set();
  var pillarOrientation = "horizontal";
  var sysmlToolbarInitialized = false;
  var lastPillarStats = {};
  var exportHandler = createExportHandler({
    getCurrentData: () => currentData,
    getViewState: () => ({ currentView, cy }),
    postMessage: (msg) => vscode && vscode.postMessage(msg)
  });
  function showLoading(message = "Rendering diagram...") {
    const overlay = document.getElementById("loading-overlay");
    const textEl = overlay?.querySelector(".loading-text");
    if (overlay) {
      if (textEl) textEl.textContent = message;
      overlay.classList.remove("hidden");
    }
    document.body.style.cursor = "wait";
  }
  function hideLoading() {
    const overlay = document.getElementById("loading-overlay");
    if (overlay) {
      overlay.classList.add("hidden");
    }
    document.body.style.cursor = "";
  }
  function webviewLog(level, ...args) {
    try {
      if (vscode && typeof vscode.postMessage === "function") {
        vscode.postMessage({ command: "webviewLog", level, args });
      }
    } catch {
    }
  }
  function setupActivityDebugToggle() {
    const debugBtn = document.getElementById("activity-debug-btn");
    if (!debugBtn) return;
    debugBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      activityDebugLabels = !activityDebugLabels;
      if (activityDebugLabels) {
        debugBtn.classList.add("active");
        debugBtn.style.background = "var(--vscode-button-background)";
        debugBtn.style.color = "var(--vscode-button-foreground)";
      } else {
        debugBtn.classList.remove("active");
        debugBtn.style.background = "";
        debugBtn.style.color = "";
      }
      if (currentView === "action-flow-view") {
        renderVisualization("action-flow-view");
      }
    });
  }
  function updateActivityDebugButtonVisibility(view) {
    const debugBtn = document.getElementById("activity-debug-btn");
    if (debugBtn) {
      debugBtn.style.display = view === "action-flow-view" ? "inline-block" : "none";
    }
    const legendBtn = document.getElementById("legend-btn");
    const legendPopup = document.getElementById("legend-popup");
    if (legendBtn) {
      const cytoscapeViews = ["general", "general-view"];
      legendBtn.style.display = cytoscapeViews.includes(view) ? "inline-block" : "none";
      if (!cytoscapeViews.includes(view) && legendPopup) {
        legendPopup.style.display = "none";
        legendBtn.classList.remove("active");
        legendBtn.style.background = "";
        legendBtn.style.color = "";
      }
    }
  }
  document.addEventListener("DOMContentLoaded", setupActivityDebugToggle);
  window.userHasManuallyZoomed = false;
  window.addEventListener("error", (e) => {
    console.error("JavaScript Error:", e.error?.message || e.message);
  });
  var lastDataHash = "";
  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.command) {
      case "showLoading":
        showLoading(message.message || "Parsing SysML model...");
        break;
      case "hideLoading":
        hideLoading();
        break;
      case "update":
        const newHash = quickHash({
          graph: message.graph
        });
        if (newHash === lastDataHash && currentData) {
          hideLoading();
          return;
        }
        lastDataHash = newHash;
        showLoading("Rendering diagram...");
        currentData = message;
        filteredData = null;
        if (message.pendingPackageName) {
          selectedDiagramName = message.pendingPackageName;
          selectedDiagramIndex = 0;
          currentView = "general-view";
        } else if (message.currentView) {
          currentView = message.currentView;
        }
        updateActiveViewButton(currentView);
        try {
          renderVisualization(currentView);
        } catch (e) {
          console.error("Error in renderVisualization:", e);
        }
        break;
      case "changeView":
        if (message.view) {
          changeView(message.view);
        }
        break;
      case "selectPackage":
        if (message.packageName) {
          selectedDiagramName = message.packageName;
          selectedDiagramIndex = 0;
          changeView("general-view");
        }
        break;
      case "export":
        if (message.format === "png") {
          exportHandler.exportPNG(message.scale || 2);
        } else if (message.format === "svg") {
          exportHandler.exportSVG();
        }
        break;
      case "highlightElement":
        highlightElementInVisualization(message.elementName, message.skipCentering);
        break;
      case "requestCurrentView":
        vscode.postMessage({
          command: "currentViewResponse",
          view: currentView
        });
        break;
      case "exportDiagramForTest":
        const svgString = exportHandler.getSvgStringForExport();
        vscode.postMessage({
          command: "testDiagramExported",
          viewId: currentView,
          svgString: svgString ?? ""
        });
        break;
    }
  });
  function updateDimensionsDisplay() {
    const vizElement = document.getElementById("visualization");
    if (vizElement) {
      const width = Math.round(vizElement.clientWidth);
      const height = Math.round(vizElement.clientHeight);
      const statusText = document.getElementById("status-text");
      if (statusText) {
        statusText.innerHTML = "Panel: " + width + " x " + height + "px - Resize via VS Code panel";
        const statusBar = document.getElementById("status-bar");
        if (statusBar) statusBar.style.display = "flex";
        setTimeout(() => {
          if (statusText.innerHTML?.includes("Panel:")) {
            statusText.textContent = "Ready";
          }
        }, 3e3);
      }
    }
  }
  var resizeTimeout;
  var lastRenderedWidth = 0;
  var lastRenderedHeight = 0;
  function handleResize() {
    const vizElement = document.getElementById("visualization");
    if (!vizElement) return;
    const currentWidth = vizElement.clientWidth;
    const currentHeight = vizElement.clientHeight;
    clearTimeout(resizeTimeout);
    updateDimensionsDisplay();
    if (cy && currentView === "sysml") {
      cy.resize();
      if (!window.userHasManuallyZoomed) {
        cy.fit(cy.elements(), 50);
      }
      lastRenderedWidth = currentWidth;
      lastRenderedHeight = currentHeight;
      return;
    }
    resizeTimeout = setTimeout(() => {
      if (currentWidth !== lastRenderedWidth || currentHeight !== lastRenderedHeight) {
        lastRenderedWidth = currentWidth;
        lastRenderedHeight = currentHeight;
        if (currentData && !isRendering) {
          renderVisualization(currentView, null, true);
        }
      }
    }, 500);
  }
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "d") {
      event.preventDefault();
      updateDimensionsDisplay();
    }
  });
  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver((entries) => {
      requestAnimationFrame(() => {
        for (let entry of entries) {
          if (entry.target.id === "visualization") {
            handleResize();
            break;
          }
        }
      });
    });
    setTimeout(() => {
      const visualizationElement = document.getElementById("visualization");
      if (visualizationElement) {
        lastRenderedWidth = visualizationElement.clientWidth;
        lastRenderedHeight = visualizationElement.clientHeight;
        resizeObserver.observe(visualizationElement);
      }
    }, 100);
  }
  window.addEventListener("resize", () => {
    requestAnimationFrame(() => {
      handleResize();
    });
  });
  var activeInlineEdit = null;
  function startInlineEdit(nodeG, elementName, x, y, width) {
    if (activeInlineEdit) {
      cancelInlineEdit();
    }
    var nameText = nodeG.select(".node-name-text");
    if (nameText.empty()) {
      nodeG.selectAll("text").each(function() {
        var textEl = d3.select(this);
        if (textEl.text() === elementName || textEl.attr("data-element-name") === elementName) {
          nameText = textEl;
        }
      });
    }
    if (nameText.empty()) return;
    var textY = parseFloat(nameText.attr("y")) || 31;
    var fontSize = nameText.style("font-size") || "11px";
    nameText.style("visibility", "hidden");
    var inputHeight = 20;
    var inputY = textY - inputHeight / 2 - 3;
    var inputPadding = 8;
    var fo = nodeG.append("foreignObject").attr("class", "inline-edit-container").attr("x", inputPadding).attr("y", inputY).attr("width", width - inputPadding * 2).attr("height", inputHeight + 4);
    var input = fo.append("xhtml:input").attr("type", "text").attr("value", elementName).attr("class", "inline-edit-input").style("width", "100%").style("height", inputHeight + "px").style("font-size", fontSize).style("font-weight", "bold").style("font-family", "var(--vscode-editor-font-family)").style("text-align", "center").style("padding", "2px 4px").style("border", "1px solid var(--vscode-focusBorder)").style("border-radius", "3px").style("background", "var(--vscode-input-background)").style("color", "var(--vscode-input-foreground)").style("outline", "none").style("box-sizing", "border-box").style("box-shadow", "0 0 0 1px var(--vscode-focusBorder)");
    activeInlineEdit = {
      foreignObject: fo,
      input,
      nameText,
      originalName: elementName,
      nodeG
    };
    var inputNode = input.node();
    setTimeout(function() {
      inputNode.focus();
      inputNode.select();
    }, 10);
    input.on("keydown", function(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        commitInlineEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelInlineEdit();
      }
      event.stopPropagation();
    });
    input.on("blur", function() {
      setTimeout(function() {
        if (activeInlineEdit) {
          cancelInlineEdit();
        }
      }, 100);
    });
    input.on("click", function(event) {
      event.stopPropagation();
    });
  }
  function commitInlineEdit() {
    if (!activeInlineEdit) return;
    var newName = activeInlineEdit.input.node().value.trim();
    var oldName = activeInlineEdit.originalName;
    activeInlineEdit.nameText.style("visibility", "visible");
    activeInlineEdit.foreignObject.remove();
    if (newName && newName !== oldName) {
      activeInlineEdit.nameText.text(newName);
      vscode.postMessage({
        command: "renameElement",
        oldName,
        newName
      });
    }
    activeInlineEdit = null;
  }
  function cancelInlineEdit() {
    if (!activeInlineEdit) return;
    activeInlineEdit.nameText.style("visibility", "visible");
    activeInlineEdit.foreignObject.remove();
    activeInlineEdit = null;
  }
  function clearVisualHighlights() {
    d3.selectAll(".highlighted-element").classed("highlighted-element", false);
    d3.selectAll(".selected").classed("selected", false);
    d3.selectAll(".node-group").style("opacity", null);
    d3.selectAll(".node-group .node-background").each(function() {
      const el = d3.select(this);
      el.style("stroke", el.attr("data-original-stroke") || "var(--vscode-panel-border)");
      el.style("stroke-width", el.attr("data-original-width") || "1px");
    });
    d3.selectAll(".general-node .node-background").each(function() {
      const el = d3.select(this);
      el.style("stroke", el.attr("data-original-stroke") || "var(--vscode-panel-border)");
      el.style("stroke-width", el.attr("data-original-width") || "2px");
    });
    d3.selectAll(".ibd-part rect:first-child").each(function() {
      const el = d3.select(this);
      const orig = el.attr("data-original-stroke");
      if (orig) {
        el.style("stroke", orig);
        el.style("stroke-width", el.attr("data-original-width") || "2px");
      }
    });
    d3.selectAll(".graph-node-group").style("opacity", null);
    d3.selectAll(".hierarchy-cell").style("opacity", null);
    if (cy) {
      cy.elements().removeClass("highlighted-sysml");
    }
  }
  function initializeSysMLToolbar() {
    if (sysmlToolbarInitialized) {
      return;
    }
    updateSysMLModeButtons();
    const toolbar = document.getElementById("sysml-toolbar");
    if (!toolbar) {
      return;
    }
    toolbar.querySelectorAll("[data-sysml-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextMode = button.getAttribute("data-sysml-mode");
        if (!nextMode || nextMode === sysmlMode) {
          return;
        }
        sysmlMode = nextMode;
        updateSysMLModeButtons();
        if (currentView === "sysml") {
          renderVisualization("sysml");
        }
      });
    });
    const orientationToggle = document.getElementById("orientation-toggle");
    if (orientationToggle) {
      orientationToggle.addEventListener("click", togglePillarOrientation);
      updateOrientationButton();
    }
    const metadataCheckbox = document.getElementById("metadata-checkbox");
    if (metadataCheckbox) {
      metadataCheckbox.addEventListener("change", toggleMetadataDisplay);
      updateMetadataCheckbox();
    }
    sysmlToolbarInitialized = true;
  }
  function setSysMLToolbarVisible(isVisible) {
    const toolbar = document.getElementById("sysml-toolbar");
    if (!toolbar) {
      return;
    }
    if (isVisible) {
      toolbar.classList.add("visible");
      initializeSysMLToolbar();
    } else {
      toolbar.classList.remove("visible");
    }
  }
  function updateSysMLModeButtons() {
    document.querySelectorAll("[data-sysml-mode]").forEach((button) => {
      const isActive = button.getAttribute("data-sysml-mode") === sysmlMode;
      button.classList.toggle("active", isActive);
    });
    const layoutButton = document.getElementById("orientation-toggle");
    if (layoutButton) {
      layoutButton.style.display = sysmlMode === "hierarchy" ? "inline-block" : "none";
    }
  }
  function togglePillarOrientation() {
    pillarOrientation = pillarOrientation === "horizontal" ? "linear" : "horizontal";
    updateOrientationButton();
    if (currentView === "sysml") {
      const st = document.getElementById("status-text");
      if (st) {
        st.textContent = pillarOrientation === "horizontal" ? "SysML Pillar View \u2022 Horizontal layout" : "SysML Pillar View \u2022 Linear top-down layout";
      }
      runSysMLLayout(true);
    }
  }
  function updateOrientationButton() {
    const button = document.getElementById("orientation-toggle");
    if (!button) {
      return;
    }
    const isLinear = pillarOrientation === "linear";
    button.classList.toggle("active", isLinear);
    button.textContent = "Layout: " + ORIENTATION_LABELS[pillarOrientation];
    button.setAttribute("aria-pressed", isLinear ? "true" : "false");
    button.title = isLinear ? "Switch to horizontal layout" : "Switch to linear (top-down) layout";
  }
  function toggleMetadataDisplay() {
    showMetadata = !showMetadata;
    updateMetadataCheckbox();
    updateNodeLabels();
  }
  function updateMetadataCheckbox() {
    const checkbox = document.getElementById("metadata-checkbox");
    if (!checkbox) {
      return;
    }
    checkbox.checked = showMetadata;
  }
  function updateNodeLabels() {
    if (!cy) {
      return;
    }
    cy.batch(function() {
      cy.nodes('[type = "element"]').forEach(function(node) {
        const baseLabel = node.data("baseLabel");
        const metadata = node.data("metadata");
        if (showMetadata && metadata) {
          const parts = [baseLabel];
          if (metadata.documentation) {
            const docText = String(metadata.documentation);
            const docShort = docText.length > 50 ? docText.substring(0, 47) + "..." : docText;
            const escapedDoc = docShort.replace(/"/g, '\\"');
            parts.push('doc: "' + escapedDoc + '"');
          }
          if (metadata.properties && Object.keys(metadata.properties).length > 0) {
            const propEntries = Object.entries(metadata.properties).slice(0, 3);
            propEntries.forEach(function(entry) {
              const key = entry[0];
              const value = entry[1];
              const valStr = String(value);
              const shortVal = valStr.length > 20 ? valStr.substring(0, 17) + "..." : valStr;
              parts.push(key + ": " + shortVal);
            });
          }
          node.data("label", parts.join("\\n"));
          node.style({
            "text-max-width": 300,
            "padding": "24px",
            "width": "label",
            "height": "label",
            "min-width": "160px",
            "min-height": "90px",
            "line-height": 1.6
          });
        } else {
          node.data("label", baseLabel);
          node.style({
            "text-max-width": 180,
            "padding": "20px",
            "width": "label",
            "height": "label",
            "min-width": "100px",
            "min-height": "60px",
            "line-height": 1.5
          });
        }
      });
    });
    if (currentView === "sysml") {
      cy.forceRender();
      setTimeout(() => {
        runSysMLLayout(true);
      }, 150);
    }
  }
  function renderPillarChips(stats = lastPillarStats) {
    const container = document.getElementById("pillar-chips");
    if (!container) {
      return;
    }
    container.innerHTML = "";
    SYSML_PILLARS.forEach((pillar) => {
      const chip = document.createElement("button");
      chip.className = "pillar-chip" + (expandedPillars.has(pillar.id) ? "" : " collapsed");
      chip.style.borderColor = PILLAR_COLOR_MAP[pillar.id];
      chip.style.color = PILLAR_COLOR_MAP[pillar.id];
      chip.dataset.pillar = pillar.id;
      const label = document.createElement("span");
      label.textContent = pillar.label;
      chip.appendChild(label);
      const badge = document.createElement("span");
      badge.className = "count-badge";
      badge.textContent = stats && stats[pillar.id] ? stats[pillar.id] : 0;
      chip.appendChild(badge);
      chip.addEventListener("click", () => {
        togglePillarExpansion(pillar.id);
      });
      container.appendChild(chip);
    });
  }
  var GENERAL_VIEW_CATEGORIES = [
    { id: "partDefs", label: "Part defs", keywords: ["part def", "part definition"], color: GENERAL_VIEW_PALETTE.structural.part },
    { id: "parts", label: "Parts", keywords: ["part"], color: GENERAL_VIEW_PALETTE.structural.part },
    { id: "portDefs", label: "Port defs", keywords: ["port def", "port definition"], color: GENERAL_VIEW_PALETTE.structural.port },
    { id: "ports", label: "Ports", keywords: ["port"], color: GENERAL_VIEW_PALETTE.structural.port },
    { id: "attributeDefs", label: "Attribute defs", keywords: ["attribute def", "attribute definition"], color: GENERAL_VIEW_PALETTE.structural.attribute },
    { id: "attributes", label: "Attributes", keywords: ["attribute"], color: GENERAL_VIEW_PALETTE.structural.attribute },
    { id: "reqDefs", label: "Requirement defs", keywords: ["requirement def", "requirement definition"], color: GENERAL_VIEW_PALETTE.requirements.requirement },
    { id: "requirements", label: "Requirements", keywords: ["requirement", "req"], color: GENERAL_VIEW_PALETTE.requirements.requirement },
    { id: "actionDefs", label: "Action defs", keywords: ["action def", "action definition"], color: GENERAL_VIEW_PALETTE.behavior.action },
    { id: "actions", label: "Actions", keywords: ["action"], color: GENERAL_VIEW_PALETTE.behavior.action },
    { id: "stateDefs", label: "State defs", keywords: ["state def", "state definition"], color: GENERAL_VIEW_PALETTE.behavior.state },
    { id: "states", label: "States", keywords: ["state"], color: GENERAL_VIEW_PALETTE.behavior.state },
    { id: "interfaceDefs", label: "Interface defs", keywords: ["interface def", "interface definition"], color: GENERAL_VIEW_PALETTE.structural.interface },
    { id: "interfaces", label: "Interfaces", keywords: ["interface"], color: GENERAL_VIEW_PALETTE.structural.interface },
    { id: "usecaseDefs", label: "Use case defs", keywords: ["use case def", "usecase def"], color: GENERAL_VIEW_PALETTE.requirements.useCase },
    { id: "usecases", label: "Use cases", keywords: ["use case", "usecase"], color: GENERAL_VIEW_PALETTE.requirements.useCase },
    { id: "allocationDefs", label: "Allocation defs", keywords: ["allocation def", "allocate def"], color: GENERAL_VIEW_PALETTE.other.allocation },
    { id: "allocations", label: "Allocations", keywords: ["allocation", "allocate"], color: GENERAL_VIEW_PALETTE.other.allocation },
    { id: "constraintDefs", label: "Constraint defs", keywords: ["constraint def", "constraint definition"], color: GENERAL_VIEW_PALETTE.other.constraint },
    { id: "constraints", label: "Constraints", keywords: ["constraint"], color: GENERAL_VIEW_PALETTE.other.constraint },
    { id: "enumerations", label: "Enumerations", keywords: ["enumeration", "enum"], color: GENERAL_VIEW_PALETTE.behavior.calc },
    { id: "metadata", label: "Metadata", keywords: ["metadata"], color: "#8B7355" },
    { id: "occurrences", label: "Occurrences", keywords: ["occurrence"], color: GENERAL_VIEW_PALETTE.structural.item },
    { id: "concerns", label: "Concerns", keywords: ["concern", "viewpoint", "stakeholder", "frame"], color: GENERAL_VIEW_PALETTE.other.allocation },
    { id: "items", label: "Items", keywords: ["item"], color: GENERAL_VIEW_PALETTE.structural.item },
    { id: "packages", label: "Packages", keywords: ["package"], color: "#6B7280" },
    { id: "other", label: "Other", keywords: [], color: "#808080" }
  ];
  var expandedGeneralCategories = /* @__PURE__ */ new Set(["partDefs", "parts", "packages"]);
  function renderGeneralChips(typeStats) {
    const container = document.getElementById("general-chips");
    if (!container) return;
    container.innerHTML = "";
    GENERAL_VIEW_CATEGORIES.forEach((cat) => {
      const count = typeStats && typeStats[cat.id] ? typeStats[cat.id] : 0;
      if (count === 0 && cat.id !== "other") return;
      const chip = document.createElement("button");
      chip.className = "pillar-chip" + (expandedGeneralCategories.has(cat.id) ? "" : " collapsed");
      chip.style.borderColor = cat.color;
      chip.style.color = cat.color;
      chip.dataset.category = cat.id;
      const label = document.createElement("span");
      label.textContent = cat.label;
      chip.appendChild(label);
      const badge = document.createElement("span");
      badge.className = "count-badge";
      badge.textContent = count;
      chip.appendChild(badge);
      chip.addEventListener("click", () => {
        if (expandedGeneralCategories.has(cat.id)) {
          expandedGeneralCategories.delete(cat.id);
        } else {
          expandedGeneralCategories.add(cat.id);
        }
        renderGeneralChips(typeStats);
        renderVisualization("general-view");
      });
      container.appendChild(chip);
    });
  }
  function getCategoryForType(typeLower) {
    for (const cat of GENERAL_VIEW_CATEGORIES) {
      if (cat.keywords.some((kw) => typeLower.includes(kw))) {
        return cat.id;
      }
    }
    return "other";
  }
  function togglePillarExpansion(pillarId) {
    if (expandedPillars.has(pillarId)) {
      expandedPillars.delete(pillarId);
    } else {
      expandedPillars.add(pillarId);
    }
    updatePillarVisibility();
    renderPillarChips(lastPillarStats);
  }
  function updatePillarVisibility() {
    if (!cy || currentView === "general-view") {
      return;
    }
    cy.batch(() => {
      const isOrthogonalMode = sysmlMode === "relationships";
      cy.nodes('[type = "pillar"]').forEach((node) => {
        const pillarId = node.data("pillar");
        const show = expandedPillars.has(pillarId);
        node.style("display", show ? "element" : "none");
      });
      cy.nodes('[type = "element"]').forEach((node) => {
        const show = expandedPillars.has(node.data("pillar"));
        node.style("display", show ? "element" : "none");
      });
      const relationshipEdges = cy.edges('[type = "relationship"]');
      cy.edges('[type = "relationship"], [type = "hierarchy"]').forEach((edge) => {
        const sourceVisible = edge.source().style("display") !== "none";
        const targetVisible = edge.target().style("display") !== "none";
        const show = sourceVisible && targetVisible;
        edge.style("display", show ? "element" : "none");
      });
    });
  }
  function getPillarForElement(element) {
    if (element && element.pillar) {
      return element.pillar;
    }
    const type = (element.type || "").toLowerCase();
    for (const pillar of SYSML_PILLARS) {
      if (pillar.keywords.some((keyword) => type.includes(keyword))) {
        return pillar.id;
      }
    }
    if (element.type && element.type.toLowerCase().includes("require")) {
      return "requirement";
    }
    if (element.type && element.type.toLowerCase().includes("use")) {
      return "usecases";
    }
    return "structure";
  }
  function propagatePillarAssignments(elements, parentPillar = null) {
    if (!elements) {
      return;
    }
    elements.forEach((element) => {
      if (!element) {
        return;
      }
      const inferred = element.type ? getPillarForElement({
        type: element.type
      }) : "structure";
      const effective = inferred !== "structure" ? inferred : parentPillar || inferred;
      element.pillar = effective || "structure";
      if (element.children && element.children.length > 0) {
        propagatePillarAssignments(element.children, element.pillar);
      }
    });
  }
  function resolveElementIdByName(name) {
    if (!name) {
      return null;
    }
    const key = name.toLowerCase();
    const matches = sysmlElementLookup.get(key);
    if (matches && matches.length > 0) {
      return matches[0];
    }
    for (const [stored, ids] of sysmlElementLookup.entries()) {
      if (stored === key && ids.length > 0) {
        return ids[0];
      }
    }
    return null;
  }
  function buildSysMLGraph(dataOrElements, relationships = [], useHierarchicalNesting = false) {
    const graph = dataOrElements?.graph;
    if (graph) {
      return graphToCytoscapeElementsForSysML(graph, useHierarchicalNesting);
    }
    const elements = Array.isArray(dataOrElements) ? dataOrElements : dataOrElements?.elements ?? [];
    sysmlElementLookup.clear();
    const cyElements = [];
    const stats = {};
    propagatePillarAssignments(elements || []);
    SYSML_PILLARS.forEach((pillar) => {
      stats[pillar.id] = 0;
      cyElements.push({
        group: "nodes",
        data: {
          id: "pillar-" + pillar.id,
          label: pillar.label,
          type: "pillar",
          pillar: pillar.id,
          color: PILLAR_COLOR_MAP[pillar.id]
        }
      });
    });
    if (useHierarchicalNesting) {
      buildHierarchicalNodes(elements || [], null, cyElements, stats, null);
    } else {
      const flattened = flattenElements(elements || [], []);
      flattened.forEach((element, index) => {
        const pillarId = element.pillar || getPillarForElement(element);
        stats[pillarId] = (stats[pillarId] || 0) + 1;
        const nodeId = "element-" + pillarId + "-" + slugify(element.name) + "-" + stats[pillarId];
        const lookupKey = element.name ? element.name.toLowerCase() : nodeId;
        const existing = sysmlElementLookup.get(lookupKey) || [];
        existing.push(nodeId);
        sysmlElementLookup.set(lookupKey, existing);
        const baseLabel = buildEnhancedElementLabel(element);
        const metadata = {
          documentation: null,
          properties: {}
        };
        metadata.documentation = extractDocumentation(element);
        if (element.attributes) {
          if (element.attributes instanceof Map) {
            element.attributes.forEach(function(value, key) {
              if (key !== "documentation") {
                metadata.properties[key] = value;
              }
            });
          } else if (typeof element.attributes === "object") {
            Object.entries(element.attributes).forEach(function(entry) {
              const key = entry[0];
              const value = entry[1];
              if (key !== "documentation") {
                metadata.properties[key] = value;
              }
            });
          }
        }
        if (element.properties) {
          Object.entries(element.properties).forEach(function(entry) {
            const key = entry[0];
            const value = entry[1];
            if (key !== "documentation") {
              metadata.properties[key] = value;
            }
          });
        }
        cyElements.push({
          group: "nodes",
          data: {
            id: nodeId,
            label: baseLabel,
            baseLabel,
            type: "element",
            pillar: pillarId,
            color: PILLAR_COLOR_MAP[pillarId],
            sysmlType: element.type,
            elementName: element.name,
            metadata
          }
        });
      });
    }
    const hierarchyLinks = createLinksFromHierarchy(elements || []);
    const hierarchyEdgeIds = /* @__PURE__ */ new Set();
    const validNodeIds = /* @__PURE__ */ new Set();
    cyElements.forEach((el) => {
      if (el.group === "nodes") {
        validNodeIds.add(el.data.id);
      }
    });
    hierarchyLinks.forEach((link) => {
      const sourceId = resolveElementIdByName(link.source);
      const targetId = resolveElementIdByName(link.target);
      if (sourceId && targetId && sourceId !== targetId && validNodeIds.has(sourceId) && validNodeIds.has(targetId)) {
        const edgeId = "hier-" + sourceId + "-" + targetId;
        if (!hierarchyEdgeIds.has(edgeId)) {
          hierarchyEdgeIds.add(edgeId);
          cyElements.push({
            group: "edges",
            data: {
              id: edgeId,
              source: sourceId,
              target: targetId,
              type: "hierarchy",
              label: ""
            }
          });
        }
      }
    });
    const relationshipEdgeIds = /* @__PURE__ */ new Set();
    (relationships || []).forEach((rel) => {
      const sourceId = resolveElementIdByName(rel.source);
      const targetId = resolveElementIdByName(rel.target);
      if (!sourceId || !targetId || sourceId === targetId || !validNodeIds.has(sourceId) || !validNodeIds.has(targetId)) {
        return;
      }
      const edgeId = "rel-" + slugify(rel.type || "rel") + "-" + slugify(rel.source) + "-" + slugify(rel.target);
      if (relationshipEdgeIds.has(edgeId)) {
        return;
      }
      relationshipEdgeIds.add(edgeId);
      let edgeLabel = rel.name || "";
      if (!edgeLabel) {
        if (rel.type === "typing") {
          edgeLabel = ": " + rel.target;
        } else {
          edgeLabel = rel.type;
        }
      }
      cyElements.push({
        group: "edges",
        data: {
          id: edgeId,
          source: sourceId,
          target: targetId,
          type: "relationship",
          relType: rel.type || "relationship",
          label: edgeLabel
        }
      });
    });
    return { elements: cyElements, stats };
  }
  function buildSyntheticTreeEdgesForGeneralView(nodes, edges) {
    const getType = (e) => (e.type || e.rel_type || "").toLowerCase();
    const containsList = edges.filter((e) => getType(e) === "contains");
    const typingList = edges.filter((e) => getType(e) === "typing");
    const nodeById = /* @__PURE__ */ new Map();
    nodes.forEach((n) => {
      if (n && n.id) nodeById.set(n.id, n);
    });
    const nodeType = (n) => (n?.type || n?.element_type || "").toLowerCase();
    const isPartDef = (n) => n && nodeType(n).includes("part def");
    const isPartUsage = (n) => n && (nodeType(n) === "part" || nodeType(n).includes("part usage"));
    const containsChildren = /* @__PURE__ */ new Map();
    const typingTarget = /* @__PURE__ */ new Map();
    containsList.forEach((e) => {
      if (!containsChildren.has(e.source)) containsChildren.set(e.source, []);
      containsChildren.get(e.source).push(e.target);
    });
    typingList.forEach((e) => {
      const src = nodeById.get(e.source);
      if (src && isPartUsage(src)) typingTarget.set(e.source, e.target);
    });
    const partDefsWithParts = [...containsChildren.entries()].filter(([pid, kids]) => {
      const p = nodeById.get(pid);
      return p && isPartDef(p) && kids.some((k) => isPartUsage(nodeById.get(k)));
    });
    const partDefIds = new Set(partDefsWithParts.map(([p]) => p));
    const containedByPackageOrRoot = /* @__PURE__ */ new Set();
    containsList.forEach((e) => {
      if (e.target && nodeById.get(e.source) && !isPartDef(nodeById.get(e.source))) {
        containedByPackageOrRoot.add(e.target);
      }
    });
    const hasNoParent = (id) => !containsList.some((e) => e.target === id);
    const candidateRoots = partDefsWithParts.filter(([pid]) => containedByPackageOrRoot.has(pid) || hasNoParent(pid)).map(([pid]) => pid);
    const pickRoot = () => {
      const byName = candidateRoots.find((id) => (nodeById.get(id)?.name || "").includes("SurveillanceQuadrotorDrone") || (nodeById.get(id)?.name || "").includes("Drone"));
      if (byName) return byName;
      const byPartCount = [...candidateRoots].sort((a, b) => (containsChildren.get(b)?.length || 0) - (containsChildren.get(a)?.length || 0));
      return byPartCount[0];
    };
    const rootId = candidateRoots.length ? pickRoot() : partDefIds.size ? [...partDefIds][0] : null;
    if (!rootId) return { edges: [], rootId: null };
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    function visitPartDef(partDefId) {
      if (seen.has(partDefId)) return;
      seen.add(partDefId);
      const kids = containsChildren.get(partDefId) || [];
      kids.forEach((childId) => {
        const c = nodeById.get(childId);
        if (!c || !isPartUsage(c)) return;
        out.push({ source: partDefId, target: childId, type: "hierarchy" });
        const defId = typingTarget.get(childId);
        if (defId && nodeById.get(defId)) {
          out.push({ source: childId, target: defId, type: "typing" });
          visitPartDef(defId);
        }
      });
    }
    visitPartDef(rootId);
    return { edges: out, rootId };
  }
  function graphToCytoscapeElementsForGeneralView(graph) {
    if (!graph || !graph.nodes?.length && !graph.edges?.length) {
      return { elements: [], typeStats: {} };
    }
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const cyElements = [];
    const typeStats = {};
    const PACKAGE_TYPES = /* @__PURE__ */ new Set(["package", "library package", "standard library package"]);
    const idToCyId = /* @__PURE__ */ new Map();
    const elementTree = graphToElementTree(graph);
    const idToElement = /* @__PURE__ */ new Map();
    function indexByKey(els) {
      if (!els || !Array.isArray(els)) return;
      els.forEach((el) => {
        if (el && el.id) idToElement.set(el.id, el);
        if (el && el.children) indexByKey(el.children);
      });
    }
    indexByKey(elementTree);
    const { edges: syntheticEdges, rootId } = buildSyntheticTreeEdgesForGeneralView(nodes, edges);
    const nodeIdsInTree = /* @__PURE__ */ new Set();
    syntheticEdges.forEach((e) => {
      nodeIdsInTree.add(e.source);
      nodeIdsInTree.add(e.target);
    });
    if (rootId) nodeIdsInTree.add(rootId);
    const typingTargetPartDefIds = new Set(syntheticEdges.filter((e) => e.type === "typing").map((e) => e.target));
    const useSyntheticTree = syntheticEdges.length > 0;
    const filteredNodes = nodes.filter((node) => {
      if (!node || isMetadataElement(node.type)) return false;
      const typeLower = (node.type || "").toLowerCase().trim();
      const isPackage = PACKAGE_TYPES.has(typeLower);
      const category = getCategoryForType(typeLower);
      const matchesCategory = isPackage ? expandedGeneralCategories.has("packages") : expandedGeneralCategories.has(category);
      const isPartDefTypingTarget = typingTargetPartDefIds.has(node.id);
      const inSyntheticTree = nodeIdsInTree.has(node.id);
      return (matchesCategory || isPartDefTypingTarget) && (!useSyntheticTree || inSyntheticTree);
    });
    const categoryOrder = new Map(GENERAL_VIEW_CATEGORIES.map((c, i) => [c.id, i]));
    filteredNodes.sort((a, b) => {
      const catA = getCategoryForType((a.type || "").toLowerCase());
      const catB = getCategoryForType((b.type || "").toLowerCase());
      const orderA = categoryOrder.get(catA) ?? 999;
      const orderB = categoryOrder.get(catB) ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    filteredNodes.forEach((node, index) => {
      const cyId = "gv-" + slugify(node.id) + "-" + index;
      idToCyId.set(node.id, cyId);
      const category = getCategoryForType((node.type || "").toLowerCase());
      typeStats[category] = (typeStats[category] || 0) + 1;
      const elementWithChildren = idToElement.get(node.id);
      const baseLabel = elementWithChildren ? buildEnhancedElementLabel(elementWithChildren) : (() => {
        const stereotype = formatSysMLStereotype(node.type);
        const displayName = node.name || "Unnamed";
        return stereotype ? stereotype + " " + displayName : displayName;
      })();
      const typeLower = (node.type || "").toLowerCase();
      const isDefinition = typeLower.includes("def") || typeLower.includes("definition");
      const color = getTypeColor(node.type);
      const cat = GENERAL_VIEW_CATEGORIES.find((c) => c.id === category);
      const borderColor = cat && cat.color || color;
      const attrs = node.attributes || {};
      const metadata = {
        documentation: typeof attrs.documentation !== "undefined" ? attrs.documentation : null,
        properties: attrs
      };
      cyElements.push({
        group: "nodes",
        data: {
          id: cyId,
          label: baseLabel,
          baseLabel,
          type: "element",
          sysmlType: node.type,
          elementName: node.name,
          color: borderColor,
          isDefinition,
          category,
          metadata,
          element: elementWithChildren || null
        }
      });
    });
    const validNodeIds = new Set(cyElements.filter((el) => el.group === "nodes").map((el) => el.data.id));
    const hierarchyEdgeIds = /* @__PURE__ */ new Set();
    const typingEdgeIds = /* @__PURE__ */ new Set();
    const resolveCyId = (backendId) => idToCyId.get(backendId) || null;
    const edgesToUse = syntheticEdges.length ? syntheticEdges : edges.filter((e) => {
      const t = (e.type || e.rel_type || "").toLowerCase();
      return t === "contains" || t === "typing";
    }).map((e) => ({
      source: e.source,
      target: e.target,
      type: (e.type || e.rel_type || "").toLowerCase() === "contains" ? "hierarchy" : "typing"
    }));
    edgesToUse.forEach((edge) => {
      const sourceCyId = resolveCyId(edge.source);
      const targetCyId = resolveCyId(edge.target);
      if (!sourceCyId || !targetCyId || sourceCyId === targetCyId || !validNodeIds.has(sourceCyId) || !validNodeIds.has(targetCyId)) return;
      const edgeType = edge.type || "hierarchy";
      if (edgeType === "hierarchy") {
        const edgeId = "hier-" + sourceCyId + "-" + targetCyId;
        if (!hierarchyEdgeIds.has(edgeId)) {
          hierarchyEdgeIds.add(edgeId);
          cyElements.push({
            group: "edges",
            data: { id: edgeId, source: sourceCyId, target: targetCyId, type: "hierarchy", label: "" }
          });
        }
      } else if (edgeType === "typing") {
        const edgeId = "rel-typing-" + sourceCyId + "-" + targetCyId;
        if (!typingEdgeIds.has(edgeId)) {
          typingEdgeIds.add(edgeId);
          cyElements.push({
            group: "edges",
            data: {
              id: edgeId,
              source: sourceCyId,
              target: targetCyId,
              type: "relationship",
              relType: "typing",
              label: ": " + (nodes.find((n) => n && n.id === edge.target)?.name || edge.target.split(/[.::]+/).pop() || edge.target)
            }
          });
        }
      }
    });
    return { elements: cyElements, typeStats };
  }
  function graphToCytoscapeElementsForSysML(graph, useHierarchicalNesting = false) {
    if (!graph || !graph.nodes?.length && !graph.edges?.length) {
      const cyElements2 = [];
      const stats2 = {};
      SYSML_PILLARS.forEach((p) => {
        stats2[p.id] = 0;
        cyElements2.push({
          group: "nodes",
          data: { id: "pillar-" + p.id, label: p.label, type: "pillar", pillar: p.id, color: PILLAR_COLOR_MAP[p.id] }
        });
      });
      return { elements: cyElements2, stats: stats2 };
    }
    sysmlElementLookup.clear();
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const cyElements = [];
    const stats = {};
    SYSML_PILLARS.forEach((p) => {
      stats[p.id] = 0;
      cyElements.push({
        group: "nodes",
        data: { id: "pillar-" + p.id, label: p.label, type: "pillar", pillar: p.id, color: PILLAR_COLOR_MAP[p.id] }
      });
    });
    const idToCyId = /* @__PURE__ */ new Map();
    const filteredNodes = nodes.filter((n) => n && !isMetadataElement(n.type));
    filteredNodes.forEach((node, index) => {
      const pillarId = getPillarForElement({ type: node.type });
      stats[pillarId] = (stats[pillarId] || 0) + 1;
      const cyId = "element-" + pillarId + "-" + slugify(node.name || node.id) + "-" + stats[pillarId];
      idToCyId.set(node.id, cyId);
      const lookupKey = (node.name || "").toLowerCase() || cyId;
      const existing = sysmlElementLookup.get(lookupKey) || [];
      existing.push(cyId);
      sysmlElementLookup.set(lookupKey, existing);
      const baseLabel = buildElementDisplayLabel({ name: node.name, type: node.type });
      const attrs = node.attributes || {};
      const metadata = {
        documentation: typeof attrs.documentation !== "undefined" ? attrs.documentation : null,
        properties: attrs
      };
      cyElements.push({
        group: "nodes",
        data: {
          id: cyId,
          label: baseLabel,
          baseLabel,
          type: "element",
          pillar: pillarId,
          color: PILLAR_COLOR_MAP[pillarId] || GENERAL_VIEW_PALETTE.other.default,
          sysmlType: node.type,
          elementName: node.name,
          metadata
        }
      });
    });
    const validNodeIds = new Set(cyElements.filter((el) => el.group === "nodes").map((el) => el.data.id));
    const resolveCyId = (backendId) => idToCyId.get(backendId) || null;
    const hierarchyEdgeIds = /* @__PURE__ */ new Set();
    const relationshipEdgeIds = /* @__PURE__ */ new Set();
    edges.forEach((edge) => {
      const sourceCyId = resolveCyId(edge.source);
      const targetCyId = resolveCyId(edge.target);
      if (!sourceCyId || !targetCyId || sourceCyId === targetCyId || !validNodeIds.has(sourceCyId) || !validNodeIds.has(targetCyId)) return;
      const isContains = (edge.type || "").toLowerCase() === "contains";
      if (isContains) {
        const edgeId = "hier-" + sourceCyId + "-" + targetCyId;
        if (!hierarchyEdgeIds.has(edgeId)) {
          hierarchyEdgeIds.add(edgeId);
          cyElements.push({
            group: "edges",
            data: { id: edgeId, source: sourceCyId, target: targetCyId, type: "hierarchy", label: "" }
          });
        }
      } else {
        const edgeId = "rel-" + slugify(edge.type || "rel") + "-" + sourceCyId + "-" + targetCyId;
        if (!relationshipEdgeIds.has(edgeId)) {
          relationshipEdgeIds.add(edgeId);
          let edgeLabel = edge.name || (edge.type === "typing" ? ": " + edge.target : edge.type || "");
          cyElements.push({
            group: "edges",
            data: {
              id: edgeId,
              source: sourceCyId,
              target: targetCyId,
              type: "relationship",
              relType: edge.type || "relationship",
              label: edgeLabel
            }
          });
        }
      }
    });
    return { elements: cyElements, stats };
  }
  function collectElementsWithDepth(els, depth, result) {
    if (!els || !Array.isArray(els)) return;
    const PACKAGE_TYPES = /* @__PURE__ */ new Set(["package", "library package", "standard library package"]);
    for (const el of els) {
      if (!el || isMetadataElement(el.type)) continue;
      const typeLower = (el.type || "").toLowerCase().trim();
      const isPackage = PACKAGE_TYPES.has(typeLower);
      const category = getCategoryForType(typeLower);
      const matchesCategory = isPackage ? expandedGeneralCategories.has("packages") : expandedGeneralCategories.has(category);
      if (matchesCategory) {
        result.push({ element: el, depth });
      }
      collectElementsWithDepth(el.children, depth + 1, result);
    }
  }
  function collectRelationshipsFromElements(els, collected = []) {
    if (!els || !Array.isArray(els)) return collected;
    for (const el of els) {
      const rels = el.relationships || [];
      for (const r of rels) {
        if (r && (r.source || r.sourceId) && (r.target || r.targetId)) {
          collected.push({
            source: r.source || r.sourceId,
            target: r.target || r.targetId,
            type: r.type || "relationship",
            name: r.name,
            sourceElement: el
          });
        }
      }
      collectRelationshipsFromElements(el.children, collected);
    }
    return collected;
  }
  function buildGeneralViewGraph(dataOrElements, relationships = []) {
    const graph = dataOrElements?.graph;
    if (graph) {
      return graphToCytoscapeElementsForGeneralView(graph);
    }
    const elements = Array.isArray(dataOrElements) ? dataOrElements : dataOrElements?.elements ?? [];
    const cyElements = [];
    const typeStats = {};
    const withDepth = [];
    collectElementsWithDepth(elements || [], 0, withDepth);
    const hierarchyLinks = createLinksFromHierarchy(elements || []);
    const flatRels = (relationships || []).filter(
      (r) => (r.type || r.rel_type) !== "typing" && (r.type || r.rel_type) !== "instanceOf"
    );
    const allRelationships = [...flatRels];
    collectRelationshipsFromElements(elements || [], allRelationships);
    function deriveTypingFromElements(els, derivedList) {
      if (!els || !Array.isArray(els)) return;
      for (const el of els) {
        const typingTargets = el.typings || (el.typing ? [el.typing] : []);
        const attrType = el.attributes?.partType || el.attributes?.get?.("partType") || el.attributes?.portType || el.attributes?.get?.("portType") || el.attributes?.actorType || el.attributes?.get?.("actorType");
        if (attrType) {
          const targets = (typeof attrType === "string" ? attrType.split(",") : [String(attrType)]).map((s) => s.trim()).filter(Boolean);
          targets.forEach((t) => derivedList.push({ sourceElement: el, target: t, type: "typing" }));
        }
        typingTargets.forEach((t) => {
          const target = (t || "").replace(/^[:~]+/, "").trim();
          if (target) derivedList.push({ sourceElement: el, target, type: "typing" });
        });
        deriveTypingFromElements(el.children, derivedList);
      }
    }
    const derivedTypingList = [];
    deriveTypingFromElements(elements || [], derivedTypingList);
    derivedTypingList.forEach((rel) => {
      if (rel.sourceElement?.name && rel.target && rel.sourceElement.name !== rel.target) {
        allRelationships.push({
          source: rel.sourceElement.name,
          target: rel.target,
          type: "typing",
          sourceElement: rel.sourceElement
        });
      }
    });
    const filtered = withDepth;
    const categoryOrder = new Map(GENERAL_VIEW_CATEGORIES.map((c, i) => [c.id, i]));
    filtered.sort((a, b) => {
      const catA = getCategoryForType((a.element.type || "").toLowerCase());
      const catB = getCategoryForType((b.element.type || "").toLowerCase());
      const orderA = categoryOrder.get(catA) ?? 999;
      const orderB = categoryOrder.get(catB) ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return String(a.element.name || "").localeCompare(String(b.element.name || ""));
    });
    const nameToNodeId = /* @__PURE__ */ new Map();
    const elementToNodeId = /* @__PURE__ */ new Map();
    filtered.forEach(({ element }, index) => {
      const nodeId = "gv-" + slugify(element.name) + "-" + index;
      elementToNodeId.set(element, nodeId);
      const lookupKey = (element.name || "").toLowerCase();
      if (!nameToNodeId.has(lookupKey)) {
        nameToNodeId.set(lookupKey, []);
      }
      nameToNodeId.get(lookupKey).push(nodeId);
      const category = getCategoryForType((element.type || "").toLowerCase());
      typeStats[category] = (typeStats[category] || 0) + 1;
      const baseLabel = buildEnhancedElementLabel(element);
      const typeLower = (element.type || "").toLowerCase();
      const isDefinition = typeLower.includes("def") || typeLower.includes("definition");
      const color = getTypeColor(element.type);
      const cat = GENERAL_VIEW_CATEGORIES.find((c) => c.id === category);
      const borderColor = cat && cat.color || color;
      const metadata = {
        documentation: extractDocumentation(element),
        properties: getElementProperties(element) || {}
      };
      cyElements.push({
        group: "nodes",
        data: {
          id: nodeId,
          label: baseLabel,
          baseLabel,
          type: "element",
          sysmlType: element.type,
          elementName: element.name,
          color: borderColor,
          isDefinition,
          category,
          metadata
        }
      });
    });
    const validNodeIds = new Set(cyElements.filter((el) => el.group === "nodes").map((el) => el.data.id));
    function resolveNodeId(name) {
      let key = (name || "").toLowerCase();
      let ids = nameToNodeId.get(key);
      if (!ids || ids.length === 0) {
        const lastSeg = key.includes("::") ? key.split("::").pop()?.trim() || key : null;
        if (lastSeg && lastSeg !== key) {
          ids = nameToNodeId.get(lastSeg);
        }
      }
      if (!ids || ids.length === 0) return null;
      return ids.find((id) => validNodeIds.has(id)) || ids[0];
    }
    const hierarchyEdgeIds = /* @__PURE__ */ new Set();
    hierarchyLinks.forEach((link) => {
      const sourceId = resolveNodeId(link.source);
      const targetId = resolveNodeId(link.target);
      if (sourceId && targetId && sourceId !== targetId && validNodeIds.has(sourceId) && validNodeIds.has(targetId)) {
        const edgeId = "hier-" + sourceId + "-" + targetId;
        if (!hierarchyEdgeIds.has(edgeId)) {
          hierarchyEdgeIds.add(edgeId);
          cyElements.push({
            group: "edges",
            data: {
              id: edgeId,
              source: sourceId,
              target: targetId,
              type: "hierarchy",
              label: ""
            }
          });
        }
      }
    });
    const relationshipEdgeIds = /* @__PURE__ */ new Set();
    allRelationships.forEach((rel) => {
      const isTyping = rel.type === "typing" || rel.relType === "typing";
      const isSpecializes = rel.type === "specializes" || rel.relType === "specializes";
      const isTypingOrSpecializes = isTyping || isSpecializes;
      const useSourceElement = rel.sourceElement && elementToNodeId.has(rel.sourceElement);
      let sourceId;
      if (isTyping) {
        if (!useSourceElement) return;
        sourceId = elementToNodeId.get(rel.sourceElement);
      } else if (useSourceElement && isSpecializes) {
        sourceId = elementToNodeId.get(rel.sourceElement);
      } else {
        sourceId = resolveNodeId(rel.source);
      }
      const targetId = resolveNodeId(rel.target);
      if (!sourceId || !targetId || sourceId === targetId || !validNodeIds.has(sourceId) || !validNodeIds.has(targetId)) {
        return;
      }
      const edgeId = "rel-" + slugify(rel.type || "rel") + "-" + sourceId + "-" + targetId;
      if (relationshipEdgeIds.has(edgeId)) return;
      relationshipEdgeIds.add(edgeId);
      let edgeLabel = rel.name || "";
      if (!edgeLabel) {
        if (rel.type === "typing") edgeLabel = ": " + rel.target;
        else if (rel.type === "specializes") edgeLabel = ":> " + rel.target;
        else edgeLabel = rel.type || "";
      }
      cyElements.push({
        group: "edges",
        data: {
          id: edgeId,
          source: sourceId,
          target: targetId,
          type: "relationship",
          relType: rel.type || "relationship",
          label: edgeLabel
        }
      });
    });
    return { elements: cyElements, typeStats };
  }
  function getGeneralViewStyles() {
    const editorFg = getCSSVariable("--vscode-editor-foreground");
    return [
      {
        selector: "node",
        style: {
          "label": "data(label)",
          "color": editorFg,
          "text-valign": "center",
          "text-halign": "center",
          "font-size": 11,
          "font-weight": 600,
          "background-color": "rgba(255,255,255,0.02)",
          "border-width": 2,
          "border-color": "data(color)",
          "padding": "18px",
          "shape": "round-rectangle",
          "text-wrap": "wrap",
          "text-max-width": 200,
          "width": "label",
          "height": "label",
          "min-width": "100px",
          "min-height": "60px",
          "compound-sizing-wrt-labels": "include",
          "text-margin-x": "5px",
          "text-margin-y": "5px",
          "line-height": 1.5
        }
      },
      {
        selector: 'node[type = "element"][isDefinition = true]',
        style: {
          "shape": "rectangle",
          "border-style": "solid",
          "border-width": 3
        }
      },
      {
        selector: 'node[type = "element"][isDefinition = false]',
        style: {
          "shape": "round-rectangle",
          "border-style": "dashed",
          "border-width": 2
        }
      },
      {
        selector: "edge",
        style: {
          "width": 2,
          "line-color": "rgba(180,200,255,0.85)",
          "target-arrow-color": "rgba(180,200,255,0.85)",
          "curve-style": "bezier",
          "target-arrow-shape": "triangle"
        }
      },
      {
        selector: 'edge[type = "hierarchy"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.part,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.part,
          "line-style": "solid",
          "width": 2,
          "target-arrow-shape": "triangle"
        }
      },
      {
        selector: 'edge[type = "relationship"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.other.default,
          "target-arrow-color": GENERAL_VIEW_PALETTE.other.default,
          "width": 2
        }
      },
      {
        selector: 'edge[relType = "typing"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.requirements.requirement,
          "target-arrow-color": GENERAL_VIEW_PALETTE.requirements.requirement,
          "line-style": "dashed",
          "width": 2,
          "target-arrow-shape": "triangle"
        }
      },
      {
        selector: 'edge[relType = "specializes"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.port,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.port,
          "line-style": "solid",
          "width": 2,
          "target-arrow-shape": "triangle-backcurve"
        }
      },
      {
        selector: 'edge[relType = "connection"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.interface,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.interface,
          "line-style": "solid",
          "width": 2.5,
          "target-arrow-shape": "none"
        }
      },
      {
        selector: 'edge[relType = "bind"]',
        style: {
          "line-color": "#808080",
          "target-arrow-color": "#808080",
          "line-style": "dashed",
          "width": 1.5,
          "target-arrow-shape": "none"
        }
      },
      {
        selector: 'edge[relType = "allocate"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.other.allocation,
          "target-arrow-color": GENERAL_VIEW_PALETTE.other.allocation,
          "line-style": "dashed",
          "width": 2,
          "target-arrow-shape": "triangle"
        }
      }
    ];
  }
  function removeNodeOverlaps() {
    if (!cy) return;
    const nodes = cy.nodes();
    const minGap = 20;
    const maxIterations = 50;
    let iter = 0;
    let hadOverlap = true;
    while (hadOverlap && iter < maxIterations) {
      hadOverlap = false;
      iter++;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const ab = a.boundingBox();
        const ax = ab.x1 + ab.w / 2;
        const ay = ab.y1 + ab.h / 2;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const bb = b.boundingBox();
          const bx = bb.x1 + bb.w / 2;
          const by = bb.y1 + bb.h / 2;
          const overlapX = ab.w / 2 + bb.w / 2 + minGap - Math.abs(ax - bx);
          const overlapY = ab.h / 2 + bb.h / 2 + minGap - Math.abs(ay - by);
          if (overlapX > 0 && overlapY > 0) {
            hadOverlap = true;
            const dx = ax - bx;
            const dy = ay - by;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = dx / dist;
            const ny = dy / dist;
            const push = Math.max(overlapX, overlapY) * 0.55;
            a.position({ x: a.position("x") + nx * push, y: a.position("y") + ny * push });
            b.position({ x: b.position("x") - nx * push, y: b.position("y") - ny * push });
          }
        }
      }
    }
  }
  function runGeneralViewLayout(fit = false) {
    if (!cy) return;
    const layoutOptions = {
      name: "elk",
      nodeDimensionsIncludeLabels: true,
      elk: {
        algorithm: "layered",
        direction: "DOWN",
        "elk.spacing.nodeNode": "150",
        "elk.layered.spacing.nodeNodeBetweenLayers": "180",
        "elk.spacing.edgeNode": "90",
        "elk.spacing.edgeEdge": "80",
        "elk.edgeRouting": "POLYLINE",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.separateConnectedComponents": "true",
        "elk.aspectRatio": "1.4",
        "elk.padding": "[top=80,left=80,bottom=80,right=80]"
      },
      fit,
      padding: 80,
      animate: true
    };
    const layout = cy.layout(layoutOptions);
    if (fit) {
      cy.one("layoutstop", () => {
        removeNodeOverlaps();
        cy.forceRender();
        fitSysMLView(80);
      });
    } else {
      cy.one("layoutstop", () => {
        removeNodeOverlaps();
        cy.forceRender();
      });
    }
    layout.run();
  }
  function getCSSVariable(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "#cccccc";
  }
  function getSysMLStyles() {
    const editorFg = getCSSVariable("--vscode-editor-foreground");
    const editorBg = getCSSVariable("--vscode-editor-background");
    const chartOrange = getCSSVariable("--vscode-charts-orange");
    const chartBlue = getCSSVariable("--vscode-charts-blue");
    const chartRed = getCSSVariable("--vscode-charts-red");
    const panelBorder = getCSSVariable("--vscode-panel-border");
    return [
      {
        selector: "node",
        style: {
          "label": "data(label)",
          "color": editorFg,
          "text-valign": "center",
          "text-halign": "center",
          "font-size": 12,
          "font-weight": 600,
          "background-color": editorBg,
          "border-width": 2,
          "border-color": "rgba(255,255,255,0.08)",
          "padding": "20px",
          "shape": "round-rectangle",
          "text-wrap": "wrap",
          "text-max-width": 180,
          "width": "label",
          "height": "label",
          "min-width": "100px",
          "min-height": "60px",
          "compound-sizing-wrt-labels": "include",
          "text-margin-x": "5px",
          "text-margin-y": "5px",
          "line-height": 1.5
        }
      },
      {
        selector: 'node[type = "pillar"]',
        style: {
          "background-color": "transparent",
          "color": "transparent",
          "font-size": 0,
          "font-weight": 0,
          "width": 1,
          "height": 1,
          "border-color": "transparent",
          "border-width": 0,
          "padding": "0px",
          "opacity": 0,
          "visibility": "hidden"
        }
      },
      {
        selector: 'node[type = "element"]',
        style: {
          "background-color": "rgba(255,255,255,0.02)",
          "border-color": "data(color)",
          "border-width": 2,
          "color": editorFg,
          "font-size": 11,
          "text-wrap": "wrap",
          "text-max-width": 200,
          "text-justification": "left",
          "text-halign": "center",
          "text-valign": "center",
          "padding": "18px",
          "width": "label",
          "height": "label",
          "min-width": "120px",
          "min-height": "60px",
          "line-height": 1.5
        }
      },
      {
        selector: "$node > node",
        style: {
          "padding-top": "35px",
          "padding-left": "10px",
          "padding-bottom": "10px",
          "padding-right": "10px",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": "12px",
          "background-color": "rgba(255,255,255,0.01)",
          "border-width": 2,
          "border-style": "dashed",
          "border-color": "rgba(255,255,255,0.15)",
          "line-height": 1.5
        }
      },
      {
        selector: "node:parent",
        style: {
          "background-opacity": 0.2,
          "background-color": "data(color)",
          "border-color": "data(color)",
          "border-width": 2,
          "border-style": "solid",
          "font-weight": 700,
          "compound-sizing-wrt-labels": "include",
          "min-width": "140px",
          "min-height": "90px",
          "line-height": 1.5
        }
      },
      {
        selector: "node.sequential-node",
        style: {
          "background-color": "rgba(255, 214, 153, 0.12)",
          "border-color": chartOrange,
          "border-width": 3
        }
      },
      {
        selector: ".highlighted-sysml",
        style: {
          "border-color": "#FFD700",
          "border-width": 4
        }
      },
      {
        selector: "edge",
        style: {
          "width": 2,
          "line-color": panelBorder,
          "target-arrow-color": panelBorder,
          "curve-style": "taxi",
          "taxi-direction": "rightward",
          "taxi-turn": "20px",
          "arrow-scale": 1,
          "color": editorFg,
          "font-size": 9,
          "text-rotation": "autorotate",
          "text-margin-x": 6,
          "text-margin-y": -8
        }
      },
      {
        selector: "edge[?label]",
        style: {
          "label": "data(label)"
        }
      },
      // --- Per-relationship-type styles (SysML v2 notation) ---
      {
        selector: 'edge[type = "relationship"]',
        style: {
          "line-color": chartBlue,
          "target-arrow-color": chartBlue,
          "width": 2,
          "line-style": "solid"
        }
      },
      {
        selector: 'edge[relType = "typing"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.requirements.requirement,
          "target-arrow-color": GENERAL_VIEW_PALETTE.requirements.requirement,
          "line-style": "dashed",
          "width": 2,
          "target-arrow-shape": "triangle",
          "arrow-scale": 1
        }
      },
      {
        selector: 'edge[relType = "specializes"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.port,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.port,
          "line-style": "solid",
          "width": 2,
          "target-arrow-shape": "triangle-backcurve",
          "arrow-scale": 1.2
        }
      },
      {
        selector: 'edge[relType = "containment"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.part,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.part,
          "line-style": "solid",
          "width": 2,
          "source-arrow-shape": "diamond",
          "source-arrow-color": GENERAL_VIEW_PALETTE.structural.part,
          "source-arrow-fill": "filled",
          "arrow-scale": 1
        }
      },
      {
        selector: 'edge[relType = "connect"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.interface,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.interface,
          "line-style": "solid",
          "width": 2.5,
          "target-arrow-shape": "none"
        }
      },
      {
        selector: 'edge[relType = "interface"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.interface,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.interface,
          "line-style": "solid",
          "width": 2.5,
          "target-arrow-shape": "circle",
          "arrow-scale": 0.8
        }
      },
      {
        selector: 'edge[relType = "flow"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.part,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.part,
          "line-style": "solid",
          "width": 2.5,
          "target-arrow-shape": "triangle",
          "arrow-scale": 1.2
        }
      },
      {
        selector: 'edge[relType = "binding"]',
        style: {
          "line-color": "#808080",
          "target-arrow-color": "#808080",
          "line-style": "dashed",
          "width": 1.5,
          "target-arrow-shape": "none"
        }
      },
      {
        selector: 'edge[relType = "allocation"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.other.allocation,
          "target-arrow-color": GENERAL_VIEW_PALETTE.other.allocation,
          "line-style": "dashed",
          "width": 2,
          "target-arrow-shape": "triangle",
          "arrow-scale": 1
        }
      },
      {
        selector: 'edge[relType = "dependency"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.other.allocation,
          "target-arrow-color": GENERAL_VIEW_PALETTE.other.allocation,
          "line-style": "dashed",
          "width": 1.5,
          "target-arrow-shape": "triangle",
          "arrow-scale": 1
        }
      },
      {
        selector: 'edge[type = "hierarchy"]',
        style: {
          "line-color": GENERAL_VIEW_PALETTE.structural.item,
          "target-arrow-color": GENERAL_VIEW_PALETTE.structural.item,
          "target-arrow-shape": "triangle",
          "line-style": "dotted",
          "width": 1.5,
          "arrow-scale": 1,
          "opacity": 0.6
        }
      },
      {
        selector: 'edge[type = "sequence-guide"]',
        style: {
          "line-color": "transparent",
          "target-arrow-color": "transparent",
          "opacity": 0,
          "width": 0.5,
          "arrow-scale": 0.1,
          "curve-style": "straight"
        }
      },
      {
        selector: 'edge[type = "sequence-order"]',
        style: {
          "line-color": chartOrange,
          "target-arrow-color": chartOrange,
          "width": 3,
          "line-style": "dashed",
          "target-arrow-shape": "triangle",
          "arrow-scale": 1.2,
          "curve-style": "straight",
          "label": ""
        }
      }
    ];
  }
  function getVisibleElementNodes() {
    if (!cy) {
      return [];
    }
    return cy.nodes('node[type = "element"]').filter((node) => node.style("display") !== "none");
  }
  function isSequentialCandidateNode(node) {
    if (!node) {
      return false;
    }
    const type = (node.data("sysmlType") || "").toLowerCase();
    const label = (node.data("label") || "").toLowerCase();
    return type.includes("action") || type.includes("behavior") || type.includes("activity") || type.includes("state") || label.includes("step") || label.includes("sequence");
  }
  function isSequentialBehaviorContext() {
    if (!cy) {
      return false;
    }
    const visibleNodes = getVisibleElementNodes();
    if (visibleNodes.length === 0) {
      return false;
    }
    const behaviorNodes = visibleNodes.filter((node) => node.data("pillar") === "behavior");
    if (behaviorNodes.length === 0) {
      return false;
    }
    const sequentialNodes = behaviorNodes.filter(isSequentialCandidateNode);
    if (sequentialNodes.length === 0) {
      return false;
    }
    const behaviorRatio = behaviorNodes.length / visibleNodes.length;
    return behaviorRatio >= 0.6 || behaviorNodes.length === visibleNodes.length;
  }
  function clearSequentialVisuals() {
    if (!cy) {
      return;
    }
    cy.batch(() => {
      cy.edges('[type = "sequence-order"]').remove();
      cy.nodes(".sequential-node").forEach((node) => {
        node.removeClass("sequential-node");
        node.data("sequenceIndex", null);
      });
    });
  }
  function clearSequentialGuides() {
    if (!cy) {
      return;
    }
    cy.edges('[type = "sequence-guide"]').remove();
  }
  function getSequentialNodes() {
    if (!cy) {
      return [];
    }
    return getVisibleElementNodes().filter((node) => node.data("pillar") === "behavior").filter(isSequentialCandidateNode).sort((a, b) => {
      const orderA = typeof a.data("orderIndex") === "number" ? a.data("orderIndex") : Number.MAX_SAFE_INTEGER;
      const orderB = typeof b.data("orderIndex") === "number" ? b.data("orderIndex") : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
  }
  function createSequentialGuides(nodes) {
    if (!cy || !nodes || nodes.length < 2) {
      return;
    }
    cy.batch(() => {
      for (let i = 0; i < nodes.length - 1; i++) {
        const current = nodes[i];
        const next = nodes[i + 1];
        cy.add({
          group: "edges",
          data: {
            id: "sequence-guide-" + current.id() + "-" + next.id(),
            source: current.id(),
            target: next.id(),
            type: "sequence-guide"
          }
        });
      }
    });
  }
  function applySequentialVisuals(nodes) {
    if (!cy || !nodes || nodes.length === 0) {
      return;
    }
    cy.batch(() => {
      nodes.forEach((node, index) => {
        const order = index + 1;
        node.data("sequenceIndex", order);
        node.addClass("sequential-node");
        if (index < nodes.length - 1) {
          const nextNode = nodes[index + 1];
          cy.add({
            group: "edges",
            data: {
              id: "sequence-order-" + node.id() + "-" + nextNode.id(),
              source: node.id(),
              target: nextNode.id(),
              type: "sequence-order"
            }
          });
        }
      });
    });
  }
  function updateSequentialOrdering(applyVisuals, sequentialContextOverride = null) {
    if (!cy) {
      return;
    }
    const sequentialContext = typeof sequentialContextOverride === "boolean" ? sequentialContextOverride : isSequentialBehaviorContext();
    clearSequentialVisuals();
    clearSequentialGuides();
    if (!sequentialContext) {
      return;
    }
    const sequentialNodes = getSequentialNodes();
    if (!sequentialNodes || sequentialNodes.length === 0) {
      return;
    }
    if (sequentialNodes.length >= 2) {
      createSequentialGuides(sequentialNodes);
    }
    if (applyVisuals) {
      applySequentialVisuals(sequentialNodes);
    }
  }
  function getSysMLSelectionCollection() {
    if (!cy) {
      return null;
    }
    let collection = cy.elements(".highlighted-sysml");
    if (!collection || collection.length === 0) {
      collection = cy.$(":selected");
    }
    if (!collection || collection.length === 0) {
      return null;
    }
    const neighborhood = collection.closedNeighborhood();
    return neighborhood.length > 0 ? neighborhood : collection;
  }
  function fitSysMLView(padding = 80, options = {}) {
    if (!cy) {
      return;
    }
    const { preferSelection = true } = options;
    if (preferSelection) {
      const selection = getSysMLSelectionCollection();
      if (selection && selection.length > 0) {
        cy.fit(selection, padding);
        return;
      }
    }
    const visibleNodes = getVisibleElementNodes();
    let collection = visibleNodes;
    if (collection.length === 0) {
      collection = cy.nodes('node[type = "pillar"]');
    } else {
      const visibleEdges = cy.edges().filter((edge) => edge.style("display") !== "none");
      collection = collection.union(visibleEdges);
    }
    if (collection.length === 0) {
      collection = cy.elements();
    }
    cy.fit(collection, padding);
  }
  function centerOnNode(node, padding = 120) {
    if (!cy || !node || node.length === 0) {
      return;
    }
    cy.animate({
      fit: {
        eles: node,
        padding
      }
    }, {
      duration: 500,
      easing: "ease-in-out"
    });
  }
  function runSysMLLayout(fit = false) {
    if (!cy) {
      return;
    }
    const sequentialContext = isSequentialBehaviorContext();
    updateSequentialOrdering(false, sequentialContext);
    const wantsLinearOrientation = pillarOrientation === "linear";
    const elkDirection = pillarOrientation === "horizontal" ? "RIGHT" : "DOWN";
    const spacingMultiplier = showMetadata ? 2.5 : 1;
    let layoutOptions;
    if (sequentialContext) {
      layoutOptions = {
        name: "elk",
        nodeDimensionsIncludeLabels: true,
        elk: {
          algorithm: "layered",
          direction: "DOWN",
          "elk.spacing.nodeNode": String(150 * spacingMultiplier),
          "elk.layered.spacing.nodeNodeBetweenLayers": String(180 * spacingMultiplier),
          "elk.spacing.edgeNode": String(90 * spacingMultiplier),
          "elk.spacing.edgeEdge": String(80 * spacingMultiplier),
          "elk.edgeRouting": "POLYLINE",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
          "elk.aspectRatio": "1.2",
          "elk.padding": "[top=100,left=100,bottom=100,right=100]"
        },
        fit,
        padding: 100,
        animate: true
      };
    } else if (sysmlMode === "hierarchy") {
      if (wantsLinearOrientation) {
        layoutOptions = {
          name: "elk",
          nodeDimensionsIncludeLabels: true,
          elk: {
            algorithm: "layered",
            direction: "DOWN",
            "elk.spacing.nodeNode": String(120 * spacingMultiplier),
            "elk.layered.spacing.nodeNodeBetweenLayers": String(150 * spacingMultiplier),
            "elk.spacing.edgeNode": String(80 * spacingMultiplier),
            "elk.spacing.edgeEdge": String(70 * spacingMultiplier),
            "elk.edgeRouting": "POLYLINE",
            "elk.hierarchyHandling": "INCLUDE_CHILDREN",
            "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
            "elk.aspectRatio": "1.0",
            "elk.padding": "[top=100,left=100,bottom=100,right=100]",
            "elk.layered.crossingMinimization.semiInteractive": "true"
          },
          fit,
          padding: 100,
          animate: true
        };
      } else {
        layoutOptions = {
          name: "breadthfirst",
          directed: true,
          padding: 100,
          spacingFactor: 1.8 * spacingMultiplier,
          animate: true,
          fit,
          avoidOverlap: true,
          nodeDimensionsIncludeLabels: true,
          circle: false,
          grid: false
        };
      }
    } else {
      layoutOptions = {
        name: "elk",
        nodeDimensionsIncludeLabels: true,
        elk: {
          algorithm: "layered",
          direction: "DOWN",
          "elk.spacing.nodeNode": String(160 * spacingMultiplier),
          "elk.layered.spacing.nodeNodeBetweenLayers": String(200 * spacingMultiplier),
          "elk.spacing.edgeNode": String(100 * spacingMultiplier),
          "elk.spacing.edgeEdge": String(80 * spacingMultiplier),
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.layered.considerModelOrder.strategy": "NONE",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.aspectRatio": "1.6",
          "elk.padding": "[top=100,left=100,bottom=100,right=100]"
        },
        fit,
        padding: 120,
        animate: true
      };
    }
    const layout = cy.layout(layoutOptions);
    if (sequentialContext || fit) {
      cy.one("layoutstop", () => {
        if (sequentialContext) {
          updateSequentialOrdering(true, true);
          const status = document.getElementById("status-text");
          if (status) {
            status.textContent = "SysML Pillar View \u2022 Sequential behaviors arranged top-down";
          }
        }
        if (fit) {
          fitSysMLView(80);
        }
      });
    }
    layout.run();
    if (sysmlMode === "relationships") {
      cy.edges('[type = "relationship"]').style({
        "opacity": 1,
        "width": 3,
        "z-index": 999
      });
      cy.edges('[type = "hierarchy"]').style({
        "opacity": 0.6,
        "width": 2
      });
    } else {
      cy.edges('[type = "relationship"]').style({
        "opacity": 0.3,
        "width": 2.5
      });
      cy.edges('[type = "hierarchy"]').style("opacity", 1);
    }
  }
  function highlightElementInVisualization(elementName, skipCentering = false) {
    clearVisualHighlights();
    let targetElement = null;
    let elementData = null;
    let sysmlTarget = null;
    if (false) {
      d3.selectAll(".node-group").each(function(d) {
        if (d && d.data && d.data.name === elementName) {
          targetElement = d3.select(this);
          elementData = d.data;
        }
      });
    } else if (currentView === "sequence-view") {
      d3.selectAll(".sequence-diagram text").each(function(d) {
        const textElement = d3.select(this);
        if (textElement.text() === elementName) {
          targetElement = textElement;
          elementData = { name: elementName, type: "sequence element" };
        }
      });
      d3.selectAll(".sequence-participant text, .sequence-message").each(function(d) {
        const element = d3.select(this);
        if (element.text && element.text() === elementName) {
          targetElement = element;
          elementData = { name: elementName, type: "sequence element" };
        }
      });
    } else if (currentView === "general-view") {
      d3.selectAll(".general-node").each(function() {
        const node = d3.select(this);
        const nodeName = node.attr("data-element-name");
        if (nodeName === elementName) {
          targetElement = node;
          elementData = { name: elementName, type: "element" };
        }
      });
    } else if (currentView === "interconnection-view") {
      d3.selectAll(".ibd-part").each(function() {
        const partG = d3.select(this);
        const partName = partG.attr("data-element-name");
        if (partName === elementName) {
          targetElement = partG;
          elementData = { name: elementName, type: "part" };
        }
      });
    } else if (currentView === "sysml" && cy) {
      const nodeId = resolveElementIdByName(elementName);
      if (nodeId) {
        const node = cy.getElementById(nodeId);
        if (node && node.length > 0) {
          sysmlTarget = node;
          elementData = {
            name: node.data("label"),
            type: node.data("sysmlType") || "element"
          };
        }
      }
    }
    if (sysmlTarget && elementData) {
      cy.elements().removeClass("highlighted-sysml");
      sysmlTarget.addClass("highlighted-sysml");
      const statusBar = document.getElementById("status-bar");
      const statusText = document.getElementById("status-text");
      if (statusText) statusText.textContent = "Selected: " + elementData.name + " [" + elementData.type + "]";
      if (statusBar) statusBar.style.display = "flex";
      if (!skipCentering) {
        centerOnNode(sysmlTarget, 80);
      }
      return;
    }
    if (targetElement && elementData) {
      targetElement.classed("highlighted-element", true);
      targetElement.select(".node-background").style("stroke", "#FFD700").style("stroke-width", "3px");
      targetElement.select("rect").style("stroke", "#FFD700").style("stroke-width", "3px");
      const statusBar = document.getElementById("status-bar");
      const statusText = document.getElementById("status-text");
      if (statusText) statusText.textContent = "Selected: " + elementData.name + " [" + elementData.type + "]";
      if (statusBar) statusBar.style.display = "flex";
      if (!skipCentering) {
        const bbox = targetElement.node().getBBox();
        const centerX = bbox.x + bbox.width / 2;
        const centerY = bbox.y + bbox.height / 2;
        const transform = d3.zoomTransform(svg.node());
        const scale = Math.min(1.5, transform.k);
        const translateX = svg.node().clientWidth / 2 - centerX * scale;
        const translateY = svg.node().clientHeight / 2 - centerY * scale;
        svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
      }
    }
  }
  function changeView(view) {
    clearTimeout(resizeTimeout);
    window.userHasManuallyZoomed = false;
    const proceedWithRender = () => {
      currentView = view;
      selectedDiagramIndex = 0;
      vscode.postMessage({
        command: "viewChanged",
        view
      });
      updateActiveViewButton(view);
      updateActivityDebugButtonVisibility(view);
      setTimeout(() => {
        renderVisualization(view);
      }, 50);
      lastView = view;
    };
    if (shouldAnimateStructuralTransition(view)) {
      animateStructuralTransition(proceedWithRender);
    } else {
      proceedWithRender();
    }
  }
  function shouldAnimateStructuralTransition(nextView) {
    return STRUCTURAL_VIEWS.has(lastView) && STRUCTURAL_VIEWS.has(nextView) && nextView !== lastView;
  }
  function animateStructuralTransition(callback) {
    const viz = document.getElementById("visualization");
    if (!viz) {
      callback();
      return;
    }
    viz.classList.add("structural-transition-active", "fade-out");
    setTimeout(() => {
      callback();
      requestAnimationFrame(() => {
        viz.classList.remove("fade-out");
        viz.classList.add("fade-in");
        setTimeout(() => {
          viz.classList.remove("fade-in", "structural-transition-active");
        }, 350);
      });
    }, 220);
  }
  function updateActiveViewButton(activeView) {
    const pillarButton = document.getElementById("sysml-btn");
    if (pillarButton) {
      pillarButton.classList.toggle("view-btn-active", activeView === "sysml");
    }
    const pillarChips = document.getElementById("pillar-chips");
    const generalChips = document.getElementById("general-chips");
    if (pillarChips) {
      pillarChips.style.display = activeView === "sysml" ? "flex" : "none";
    }
    if (generalChips) {
      generalChips.style.display = activeView === "general-view" ? "flex" : "none";
    }
    const layoutDirBtn = document.getElementById("layout-direction-btn");
    if (layoutDirBtn) {
      const showLayoutBtn = ["state-transition-view"].includes(activeView);
      layoutDirBtn.style.display = showLayoutBtn ? "inline-flex" : "none";
    }
    const dropdownButton = document.getElementById("view-dropdown-btn");
    const dropdownConfig = VIEW_OPTIONS[activeView];
    if (dropdownButton) {
      if (dropdownConfig) {
        dropdownButton.classList.add("view-btn-active");
        dropdownButton.innerHTML = '<span class="codicon codicon-chevron-down" style="margin-right: 2px;"></span><span>' + dropdownConfig.label + "</span>";
      } else {
        dropdownButton.classList.remove("view-btn-active");
        dropdownButton.innerHTML = '<span class="codicon codicon-chevron-down" style="margin-right: 2px;"></span><span>Views</span>';
      }
    }
    document.querySelectorAll(".view-dropdown-item").forEach((item) => {
      const isMatch = item.getAttribute("data-view") === activeView;
      item.classList.toggle("active", isMatch);
    });
    updateLayoutDirectionButton(activeView);
    updateDiagramSelector(activeView);
  }
  function updateDiagramSelector(activeView) {
    const pkgDropdown = document.getElementById("pkg-dropdown");
    const pkgMenu = document.getElementById("pkg-dropdown-menu");
    const pkgLabel = document.getElementById("pkg-dropdown-label");
    if (!pkgDropdown || !pkgMenu || !currentData) {
      if (pkgDropdown) pkgDropdown.style.display = "none";
      return;
    }
    let diagrams = [];
    let labelText = "Package";
    if (activeView === "general-view") {
      let findPackages2 = function(elementList, depth = 0) {
        elementList.forEach((el) => {
          const typeLower = (el.type || "").toLowerCase();
          if (typeLower.includes("package") && !seenPackages.has(el.name)) {
            seenPackages.add(el.name);
            packagesArray.push({ name: el.name, element: el });
          }
          if (el.children && el.children.length > 0) {
            findPackages2(el.children, depth + 1);
          }
        });
      };
      var findPackages = findPackages2;
      const elements = currentData?.elements ?? (currentData?.graph ? graphToElementTree(currentData.graph) : []);
      const packagesArray = [];
      const seenPackages = /* @__PURE__ */ new Set();
      diagrams.push({ name: "All Packages", element: null, isAll: true });
      findPackages2(elements);
      packagesArray.forEach((pkg) => {
        diagrams.push(pkg);
      });
      labelText = "Package";
    } else if (activeView === "action-flow-view") {
      const preparedData = prepareDataForView(currentData, "action-flow-view");
      diagrams = preparedData?.diagrams || [];
      labelText = "Action Flow";
    } else if (activeView === "state-transition-view") {
      let findStateMachinesForSelector2 = function(stateList) {
        stateList.forEach((s) => {
          const typeLower = (s.type || "").toLowerCase();
          const nameLower = (s.name || "").toLowerCase();
          const isContainer = typeLower.includes("exhibit") || nameLower.endsWith("states") || typeLower.includes("state") && s.children && s.children.length > 0 && s.children.some((c) => (c.type || "").toLowerCase().includes("state"));
          if (isContainer && !typeLower.includes("def")) {
            stateMachineMap.set(s.name, s);
          }
          if (s.children && s.children.length > 0) {
            findStateMachinesForSelector2(s.children);
          }
        });
      };
      var findStateMachinesForSelector = findStateMachinesForSelector2;
      const preparedData = prepareDataForView(currentData, "state-transition-view");
      const stateElements = preparedData?.states || [];
      const stateMachineMap = /* @__PURE__ */ new Map();
      findStateMachinesForSelector2(stateElements);
      diagrams = Array.from(stateMachineMap.entries()).map(([name, element]) => ({
        name,
        element
      }));
      if (diagrams.length === 0 && stateElements.length > 0) {
        diagrams = [{ name: "All States", element: null }];
      }
      labelText = "State Machine";
    } else if (activeView === "sequence-view") {
      diagrams = currentData?.sequenceDiagrams || [];
      labelText = "Sequence";
    } else if (activeView === "interconnection-view") {
      const preparedData = prepareDataForView({ ...currentData, selectedIbdRoot }, "interconnection-view");
      const candidates = preparedData?.ibdRootCandidates || [];
      if (candidates.length > 0) {
        diagrams = candidates.map((name) => ({ name }));
        labelText = "Block";
        const preferredRoot = preparedData?.selectedIbdRoot && candidates.indexOf(preparedData.selectedIbdRoot) >= 0 ? preparedData.selectedIbdRoot : selectedIbdRoot && candidates.indexOf(selectedIbdRoot) >= 0 ? selectedIbdRoot : candidates[0] || null;
        selectedDiagramIndex = preferredRoot ? candidates.indexOf(preferredRoot) : 0;
        selectedDiagramName = preferredRoot;
        selectedIbdRoot = selectedDiagramName;
        try {
          webviewLog("info", "[IBD] selector", {
            candidates,
            preferredRoot,
            selectedIbdRoot_state: selectedIbdRoot,
            selectedDiagramIndex
          });
        } catch {
        }
      } else {
        diagrams = [{ name: "Default", element: null }];
        labelText = "Block";
      }
    }
    if (diagrams.length <= 1) {
      pkgDropdown.style.display = "none";
      selectedDiagramIndex = 0;
      selectedDiagramName = diagrams.length === 1 ? diagrams[0].name : null;
      return;
    }
    pkgDropdown.style.display = "flex";
    if (pkgLabel) pkgLabel.textContent = labelText;
    if (selectedDiagramName) {
      const matchingIndex = diagrams.findIndex((d) => d.name === selectedDiagramName);
      if (matchingIndex >= 0) {
        selectedDiagramIndex = matchingIndex;
        if (pkgLabel) pkgLabel.textContent = selectedDiagramName;
      } else {
        selectedDiagramIndex = 0;
        selectedDiagramName = diagrams[0]?.name || null;
      }
    } else {
      selectedDiagramName = diagrams[0]?.name || null;
    }
    pkgMenu.innerHTML = "";
    diagrams.forEach((d, idx) => {
      const item = document.createElement("button");
      item.className = "view-dropdown-item";
      item.textContent = d.name || "Diagram " + (idx + 1);
      if (idx === selectedDiagramIndex) item.classList.add("active");
      item.addEventListener("click", function() {
        selectedDiagramIndex = idx;
        selectedDiagramName = d.name;
        if (activeView === "interconnection-view") selectedIbdRoot = d.name;
        pkgMenu.querySelectorAll(".view-dropdown-item").forEach((i) => i.classList.remove("active"));
        item.classList.add("active");
        if (pkgLabel) pkgLabel.textContent = d.name;
        pkgMenu.classList.remove("show");
        renderVisualization(currentView);
      });
      pkgMenu.appendChild(item);
    });
    if (selectedDiagramIndex >= diagrams.length) {
      selectedDiagramIndex = 0;
      selectedDiagramName = diagrams[0]?.name || null;
    }
  }
  var LAYOUT_DIRECTION_LABELS = {
    "horizontal": "Left \u2192 Right",
    "vertical": "Top \u2192 Down",
    "auto": "Auto Layout"
  };
  var LAYOUT_DIRECTION_ICONS = {
    "horizontal": "codicon-arrow-right",
    "vertical": "codicon-arrow-down",
    "auto": "codicon-editor-layout"
  };
  function updateLayoutDirectionButton(activeView) {
    const layoutBtn = document.getElementById("layout-direction-btn");
    if (layoutBtn) {
      const effectiveDirection = activeView === "action-flow-view" ? activityLayoutDirection : layoutDirection;
      const iconClass = LAYOUT_DIRECTION_ICONS[effectiveDirection] || "codicon-arrow-right";
      const label = LAYOUT_DIRECTION_LABELS[effectiveDirection] || "Left \u2192 Right";
      layoutBtn.innerHTML = '<span class="codicon ' + iconClass + '"></span> ' + label;
      const nextMode = getNextLayoutDirection(effectiveDirection);
      const nextLabel = LAYOUT_DIRECTION_LABELS[nextMode];
      layoutBtn.title = "Switch to " + nextLabel;
      stateLayoutOrientation = layoutDirection === "auto" ? "force" : layoutDirection;
    }
  }
  function getNextLayoutDirection(current) {
    const modes = ["horizontal", "vertical", "auto"];
    const currentIndex = modes.indexOf(current);
    return modes[(currentIndex + 1) % modes.length];
  }
  function toggleLayoutDirection() {
    if (currentView === "action-flow-view") {
      activityLayoutDirection = getNextLayoutDirection(activityLayoutDirection);
    } else {
      layoutDirection = getNextLayoutDirection(layoutDirection);
    }
    updateLayoutDirectionButton(currentView);
    renderVisualization(currentView);
  }
  window.changeView = changeView;
  function renderVisualization(view, preserveZoomOverride = null, allowDuringResize = false) {
    if (!currentData) {
      return;
    }
    if (isRendering) {
      return;
    }
    const viewChanged = view !== lastView;
    if (viewChanged) {
      window.userHasManuallyZoomed = false;
    }
    let baseData = filteredData || currentData;
    if (selectedDiagramIndex > 0 && view === "interconnection-view") {
      let findPackagesForRender2 = function(elementList, depth = 0) {
        (elementList || []).forEach((el) => {
          const typeLower = (el.type || "").toLowerCase();
          if (typeLower.includes("package") && depth <= 3 && !seenPackages.has(el.name)) {
            seenPackages.add(el.name);
            packagesArray.push({ name: el.name, element: el });
          }
          if (el.children && el.children.length > 0) {
            findPackagesForRender2(el.children, depth + 1);
          }
        });
      };
      var findPackagesForRender = findPackagesForRender2;
      const elements = baseData?.elements ?? (baseData?.graph ? graphToElementTree(baseData.graph) : []);
      const packagesArray = [];
      const seenPackages = /* @__PURE__ */ new Set();
      findPackagesForRender2(elements);
      const selectedPackageIdx = selectedDiagramIndex - 1;
      if (selectedPackageIdx >= 0 && selectedPackageIdx < packagesArray.length) {
        const selectedPackage = packagesArray[selectedPackageIdx];
        if (selectedPackage.element) {
          baseData = {
            ...baseData,
            elements: [selectedPackage.element]
          };
        }
      }
    }
    const dataForPrepare = view === "interconnection-view" ? { ...baseData, selectedIbdRoot } : baseData;
    const dataToRender = prepareDataForView(dataForPrepare, view);
    if (view === "interconnection-view") {
      const ibd = dataForPrepare?.ibd;
      const deepPropulsion = Array.isArray(ibd?.parts) ? ibd.parts.map((p) => p?.qualifiedName).filter((qn) => typeof qn === "string" && qn.includes(".propulsion.") && qn.split(".").length >= 4) : [];
      webviewLog(
        "info",
        "[IBD] prepare",
        {
          hasIbd: !!ibd,
          defaultRoot: ibd?.defaultRoot ?? null,
          rootCandidates: Array.isArray(ibd?.rootCandidates) ? ibd.rootCandidates : null,
          selectedIbdRoot_state: selectedIbdRoot ?? null,
          selectedIbdRoot_prepared: dataToRender?.selectedIbdRoot ?? null,
          partsCount: Array.isArray(dataToRender?.parts) ? dataToRender.parts.length : null,
          connectorsCount: Array.isArray(dataToRender?.connectors) ? dataToRender.connectors.length : null,
          deepPropulsionCount: deepPropulsion.length,
          deepPropulsionSample: deepPropulsion.slice(0, 5)
        }
      );
    }
    isRendering = true;
    showLoading("Rendering " + (VIEW_OPTIONS[view]?.label || view) + "...");
    const renderSafetyTimeout = setTimeout(() => {
      if (isRendering) {
        isRendering = false;
      }
    }, 1e4);
    const vizElement = document.getElementById("visualization");
    try {
      let buildElkContext2 = function() {
        return {
          elkWorkerUrl,
          getCy: () => cy,
          setCy: (c) => {
            cy = c;
          },
          getSvg: () => svg,
          getG: () => g,
          buildSysMLGraph,
          buildGeneralViewGraph,
          getGeneralViewStyles,
          runGeneralViewLayout,
          setSysMLToolbarVisible,
          renderPillarChips,
          setLastPillarStats: (stats) => {
            lastPillarStats = stats;
          },
          getSysMLStyles,
          runSysMLLayout,
          updatePillarVisibility,
          togglePillarExpansion,
          centerOnNode,
          isSequentialBehaviorContext,
          postMessage: (msg) => vscode.postMessage(msg),
          SYSML_PILLARS,
          PILLAR_COLOR_MAP,
          sysmlMode,
          getCategoryForType,
          expandedGeneralCategories,
          GENERAL_VIEW_CATEGORIES,
          renderGeneralChips,
          reRenderElk: () => renderVisualization("general-view"),
          showCategoryHeaders,
          selectedDiagramIndex,
          currentData,
          clearVisualHighlights,
          renderPlaceholder: (wd, ht, viewName, message, d) => renderPlaceholderView(wd, ht, viewName, message, d),
          isLibraryValidated,
          getLibraryKind,
          getLibraryChain,
          onStartInlineEdit: (nodeG, elementName, x, y, wd) => startInlineEdit(nodeG, elementName, x, y, wd)
        };
      }, buildRenderContext2 = function(w, h) {
        return {
          width: w,
          height: h,
          svg,
          g,
          zoom,
          getCy: () => cy,
          layoutDirection,
          activityLayoutDirection,
          activityDebugLabels,
          stateLayoutOrientation,
          selectedDiagramIndex,
          postMessage: (msg) => vscode.postMessage(msg),
          onStartInlineEdit: (nodeG, elementName, x, y, wd) => startInlineEdit(nodeG, elementName, x, y, wd),
          renderPlaceholder: (wd, ht, viewName, message, d) => renderPlaceholderView(wd, ht, viewName, message, d),
          clearVisualHighlights,
          elkWorkerUrl
        };
      };
      var buildElkContext = buildElkContext2, buildRenderContext = buildRenderContext2;
      let currentTransform = d3.zoomIdentity;
      let shouldPreserveZoom = false;
      if (svg && zoom) {
        try {
          currentTransform = d3.zoomTransform(svg.node());
          shouldPreserveZoom = window.userHasManuallyZoomed === true;
        } catch (e) {
          shouldPreserveZoom = false;
          currentTransform = d3.zoomIdentity;
        }
      }
      d3.select("#visualization").selectAll("*").remove();
      const width = document.getElementById("visualization").clientWidth;
      const height = document.getElementById("visualization").clientHeight;
      if (view === "sysml") {
        renderSysMLView(buildElkContext2(), width, height, dataToRender);
        lastView = view;
        setTimeout(() => {
          isRendering = false;
          hideLoading();
        }, 100);
        return;
      }
      svg = d3.select("#visualization").append("svg").attr("width", width).attr("height", height);
      zoom = d3.zoom().scaleExtent([MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM]).on("zoom", (event) => {
        g.attr("transform", event.transform);
        if (event.sourceEvent) {
          window.userHasManuallyZoomed = true;
        }
      });
      svg.call(zoom).on("dblclick.zoom", null).on("wheel.zoom", function(event) {
        event.preventDefault();
        window.userHasManuallyZoomed = true;
        const mouse = d3.pointer(event, this);
        const currentTransform2 = d3.zoomTransform(this);
        const factor = event.deltaY > 0 ? 0.7 : 1.45;
        const newScale = Math.min(
          Math.max(currentTransform2.k * factor, MIN_CANVAS_ZOOM),
          MAX_CANVAS_ZOOM
        );
        const translateX = mouse[0] - (mouse[0] - currentTransform2.x) * (newScale / currentTransform2.k);
        const translateY = mouse[1] - (mouse[1] - currentTransform2.y) * (newScale / currentTransform2.k);
        d3.select(this).transition().duration(50).call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(newScale));
      });
      g = svg.append("g");
      const restoreZoom = () => {
        if (shouldPreserveZoom && currentTransform) {
          setTimeout(() => {
            svg.transition().duration(0).call(zoom.transform, currentTransform);
          }, 10);
        }
      };
      svg.on("click", (event) => {
        if (event.target === svg.node() || event.target === g.node()) {
          clearVisualHighlights();
          g.selectAll(".expanded-details").remove();
          g.selectAll(".graph-node-background").each(function() {
            const el = d3.select(this);
            el.style("stroke", el.attr("data-original-stroke") || "var(--vscode-panel-border)");
            el.style("stroke-width", el.attr("data-original-width") || "2px");
          });
          g.selectAll(".node-group").classed("selected", false);
          g.selectAll(".graph-node-group").classed("selected", false);
          g.selectAll(".hierarchy-cell").classed("selected", false);
          g.selectAll(".elk-node").classed("selected", false);
          g.selectAll(".ibd-connector").each(function() {
            const el = d3.select(this);
            const origStroke = el.attr("data-original-stroke");
            const origWidth = el.attr("data-original-width");
            if (origStroke) {
              el.style("stroke", origStroke).style("stroke-width", origWidth).classed("connector-highlighted", false);
              el.attr("data-original-stroke", null).attr("data-original-width", null);
            }
          });
          g.selectAll(".general-connector").each(function() {
            const el = d3.select(this);
            const origStroke = el.attr("data-original-stroke");
            const origWidth = el.attr("data-original-width");
            if (origStroke) {
              el.style("stroke", origStroke).style("stroke-width", origWidth).classed("connector-highlighted", false);
              el.attr("data-original-stroke", null).attr("data-original-width", null);
            }
          });
        }
      });
      if (view === "general-view") {
        const generalCtx = {
          ...buildRenderContext2(width, height),
          buildGeneralViewGraph,
          renderGeneralChips,
          elkWorkerUrl
        };
        renderGeneralViewD3(generalCtx, dataToRender).then(() => {
          setTimeout(() => {
            zoomToFit("auto");
            updateDimensionsDisplay();
            isRendering = false;
            hideLoading();
          }, 100);
        }).catch((err) => {
          console.error("[General View] Render failed:", err);
          isRendering = false;
          hideLoading();
        });
      } else if (view === "sequence-view") {
        renderSequenceView(buildRenderContext2(width, height), dataToRender);
      } else if (view === "interconnection-view") {
        renderIbdView(buildRenderContext2(width, height), dataToRender).then(() => {
          setTimeout(() => {
            zoomToFit("auto");
            updateDimensionsDisplay();
            isRendering = false;
            hideLoading();
          }, 100);
        }).catch((err) => {
          console.error("[Interconnection View] Render failed:", err);
          isRendering = false;
          hideLoading();
        });
      } else if (view === "action-flow-view") {
        renderActivityView(buildRenderContext2(width, height), dataToRender);
      } else if (view === "state-transition-view") {
        renderStateView(buildRenderContext2(width, height), dataToRender);
      } else {
        renderPlaceholderView(width, height, "Unknown View", "The selected view is not yet implemented.", dataToRender);
      }
      if (view !== "general-view" && view !== "interconnection-view") {
        if (shouldPreserveZoom) {
          restoreZoom();
        } else {
          setTimeout(() => zoomToFit("auto"), 100);
        }
        setTimeout(() => {
          updateDimensionsDisplay();
          isRendering = false;
          hideLoading();
        }, 200);
      }
      lastView = view;
    } catch (error) {
      console.error("Error during rendering:", error);
      isRendering = false;
      hideLoading();
      const statusText = document.getElementById("status-text");
      if (statusText) {
        statusText.textContent = "Error rendering visualization: " + error.message;
      }
    }
  }
  function buildHierarchicalNodes(elements, parentId = null, cyElements = [], stats = {}, parentPillarId = null) {
    elements.forEach((el) => {
      const pillarId = el.pillar || parentPillarId || getPillarForElement(el);
      stats[pillarId] = (stats[pillarId] || 0) + 1;
      const nodeId = "element-" + pillarId + "-" + slugify(el.name) + "-" + stats[pillarId];
      const lookupKey = el.name ? el.name.toLowerCase() : nodeId;
      const existing = sysmlElementLookup.get(lookupKey) || [];
      existing.push(nodeId);
      sysmlElementLookup.set(lookupKey, existing);
      const properties = normalizeAttributes(el.attributes);
      const documentation = extractDocumentation(el);
      if (documentation) {
        properties["documentation"] = documentation;
      }
      const baseLabel = buildElementDisplayLabel(el);
      const metadata = {
        documentation: documentation || null,
        properties: {}
      };
      Object.entries(properties).forEach(function(entry) {
        const key = entry[0];
        const value = entry[1];
        if (key !== "documentation") {
          metadata.properties[key] = value;
        }
      });
      const nodeData = {
        id: nodeId,
        label: baseLabel,
        baseLabel,
        type: "element",
        pillar: pillarId,
        color: PILLAR_COLOR_MAP[pillarId],
        sysmlType: el.type,
        elementName: el.name,
        metadata
      };
      if (parentId) {
        nodeData.parent = parentId;
      }
      cyElements.push({
        group: "nodes",
        data: nodeData
      });
      if (el.children && el.children.length > 0) {
        const nonMetadataChildren = el.children.filter(
          (child) => !isMetadataElement(child.type)
        );
        if (nonMetadataChildren.length > 0) {
          buildHierarchicalNodes(nonMetadataChildren, nodeId, cyElements, stats, pillarId);
        }
      }
    });
    return cyElements;
  }
  function getHighlightedSvgBounds() {
    if (!g) {
      return null;
    }
    const highlighted = Array.from(g.node().querySelectorAll(".highlighted-element, .selected"));
    if (highlighted.length === 0) {
      return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    highlighted.forEach((element) => {
      if (!element || typeof element.getBBox !== "function") {
        return;
      }
      try {
        const bbox = element.getBBox();
        if (!bbox || bbox.width === 0 && bbox.height === 0) {
          return;
        }
        minX = Math.min(minX, bbox.x);
        minY = Math.min(minY, bbox.y);
        maxX = Math.max(maxX, bbox.x + bbox.width);
        maxY = Math.max(maxY, bbox.y + bbox.height);
      } catch (e) {
        return;
      }
    });
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      return null;
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }
  function resetZoom() {
    const cytoscapeViews = ["sysml"];
    if (cytoscapeViews.includes(currentView) && cy) {
      cy.reset();
      fitSysMLView(80, { preferSelection: false });
      return;
    }
    window.userHasManuallyZoomed = true;
    if (svg) svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
  }
  function zoomToFit(trigger = "user") {
    const isAuto = trigger === "auto";
    const cytoscapeViews = ["sysml"];
    if (cytoscapeViews.includes(currentView) && cy) {
      fitSysMLView(80, { preferSelection: true });
      return;
    }
    if (!g || !svg) return;
    try {
      if (!isAuto) {
        window.userHasManuallyZoomed = true;
      }
      const selectionBounds = getHighlightedSvgBounds();
      const bounds = selectionBounds || g.node().getBBox();
      if (!bounds || bounds.width === 0 || bounds.height === 0) return;
      const svgWidth = +svg.attr("width");
      const svgHeight = +svg.attr("height");
      const basePadding = selectionBounds ? 0.06 : 0.08;
      const padding = Math.min(svgWidth, svgHeight) * basePadding;
      const scaleX = (svgWidth - 2 * padding) / bounds.width;
      const scaleY = (svgHeight - 2 * padding) / bounds.height;
      const scale = Math.min(scaleX, scaleY);
      const maxScale = selectionBounds ? 3 : 1;
      const finalScale = Math.max(Math.min(scale, maxScale), MIN_CANVAS_ZOOM);
      const centerX = svgWidth / 2;
      const centerY = svgHeight / 2;
      const boundsX = bounds.x + bounds.width / 2;
      const boundsY = bounds.y + bounds.height / 2;
      const translateX = centerX - boundsX * finalScale;
      const translateY = centerY - boundsY * finalScale;
      svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(finalScale));
    } catch (error) {
      console.warn("Error in zoomToFit:", error);
      resetZoom();
    }
  }
  window.exportPNG = (scale) => exportHandler.exportPNG(scale);
  window.exportSVG = () => exportHandler.exportSVG();
  window.exportJSON = () => exportHandler.exportJSON();
  window.resetZoom = resetZoom;
  window.zoomToFit = zoomToFit;
  function wrapTextToFit(line, maxCharsPerLine) {
    if (!line || line.length <= maxCharsPerLine) return [line];
    const words = line.split(/\s+/);
    const result = [];
    let current = "";
    for (const w of words) {
      const next = current ? current + " " + w : w;
      if (next.length <= maxCharsPerLine) {
        current = next;
      } else {
        if (current) result.push(current);
        if (w.length > maxCharsPerLine) {
          for (let i = 0; i < w.length; i += maxCharsPerLine) {
            result.push(w.substring(i, i + maxCharsPerLine));
          }
          current = "";
        } else {
          current = w;
        }
      }
    }
    if (current) result.push(current);
    return result;
  }
  function renderPlaceholderView(width, height, viewName, message, data) {
    const centerX = width / 2;
    const centerY = height / 2;
    const messageGroup = g.append("g").attr("class", "placeholder-message").attr("transform", "translate(" + centerX + "," + centerY + ")");
    const rawLines = message.split(/\n|\\n/).filter((l) => l.length > 0);
    const maxCharsPerLine = 38;
    const wrappedLines = [];
    rawLines.forEach((l) => wrappedLines.push.apply(wrappedLines, wrapTextToFit(l, maxCharsPerLine)));
    const hasFooter = data && (data.elements && data.elements.length > 0 || data.graph?.nodes && data.graph.nodes.length > 0);
    const cardWidth = 320;
    const lineHeight = 22;
    const cardHeight = Math.max(120, 70 + wrappedLines.length * lineHeight + (hasFooter ? 30 : 0));
    messageGroup.append("rect").attr("x", -cardWidth / 2).attr("y", -cardHeight / 2).attr("width", cardWidth).attr("height", cardHeight).attr("rx", 8).attr("ry", 8).style("fill", "var(--vscode-editor-inactiveSelectionBackground)").style("stroke", "var(--vscode-panel-border)").style("stroke-width", "1px");
    messageGroup.append("text").attr("x", 0).attr("y", -cardHeight / 2 + 28).attr("text-anchor", "middle").text(viewName).style("font-size", "18px").style("fill", "var(--vscode-editor-foreground)").style("font-weight", "600");
    wrappedLines.forEach((line, i) => {
      messageGroup.append("text").attr("x", 0).attr("y", -cardHeight / 2 + 52 + i * lineHeight).attr("text-anchor", "middle").text(line).style("font-size", "13px").style("fill", "var(--vscode-descriptionForeground)");
    });
    const elementCount = (data?.elements?.length ?? 0) || (data?.graph?.nodes?.length ?? 0);
    if (data && elementCount > 0) {
      messageGroup.append("text").attr("x", 0).attr("y", cardHeight / 2 - 20).attr("text-anchor", "middle").text(elementCount + " element(s) in model").style("font-size", "11px").style("fill", "var(--vscode-descriptionForeground)").style("opacity", "0.8");
    }
  }
  var viewDropdownBtn = document.getElementById("view-dropdown-btn");
  var viewDropdownMenu = document.getElementById("view-dropdown-menu");
  if (viewDropdownBtn && viewDropdownMenu) {
    viewDropdownBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = viewDropdownMenu.classList.contains("show");
      viewDropdownMenu.classList.toggle("show", !isVisible);
    });
  }
  var dropdownItems = document.querySelectorAll(".view-dropdown-item");
  dropdownItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      const selectedView = e.currentTarget.getAttribute("data-view");
      if (viewDropdownMenu) {
        viewDropdownMenu.classList.remove("show");
      }
      if (selectedView === "dashboard") {
        vscode.postMessage({ command: "executeCommand", args: ["sysml.showModelDashboard"] });
      } else if (selectedView) {
        changeView(selectedView);
      }
    });
  });
  updateActiveViewButton(currentView);
  document.getElementById("reset-btn").addEventListener("click", resetZoom);
  document.getElementById("layout-direction-btn").addEventListener("click", toggleLayoutDirection);
  (function setupLegend() {
    const legendBtn = document.getElementById("legend-btn");
    const legendPopup = document.getElementById("legend-popup");
    const legendCloseBtn = document.getElementById("legend-close-btn");
    if (!legendBtn || !legendPopup) return;
    function showLegend() {
      legendPopup.style.display = "block";
      legendPopup.style.top = "12px";
      legendPopup.style.right = "12px";
      legendPopup.style.left = "";
      legendPopup.style.bottom = "";
      legendBtn.classList.add("active");
      legendBtn.style.background = "var(--vscode-button-background)";
      legendBtn.style.color = "var(--vscode-button-foreground)";
    }
    function hideLegend() {
      legendPopup.style.display = "none";
      legendBtn.classList.remove("active");
      legendBtn.style.background = "";
      legendBtn.style.color = "";
    }
    legendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const showing = legendPopup.style.display === "block";
      if (showing) {
        hideLegend();
      } else {
        showLegend();
      }
    });
    if (legendCloseBtn) {
      legendCloseBtn.addEventListener("click", () => {
        hideLegend();
      });
    }
    document.addEventListener("click", (e) => {
      if (legendPopup.style.display === "block" && !legendPopup.contains(e.target) && !legendBtn.contains(e.target)) {
        hideLegend();
      }
    });
  })();
  (function setupLegendDrag() {
    const legendPopup = document.getElementById("legend-popup");
    const legendHeader = document.getElementById("legend-header");
    if (!legendPopup || !legendHeader) return;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let popupStartLeft = 0;
    let popupStartTop = 0;
    legendHeader.addEventListener("mousedown", (e) => {
      if (e.target.id === "legend-close-btn") return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = legendPopup.getBoundingClientRect();
      const wrapperRect = legendPopup.parentElement.getBoundingClientRect();
      popupStartLeft = rect.left - wrapperRect.left;
      popupStartTop = rect.top - wrapperRect.top;
      legendPopup.style.right = "";
      legendPopup.style.left = popupStartLeft + "px";
      legendPopup.style.top = popupStartTop + "px";
      legendHeader.style.cursor = "grabbing";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      legendPopup.style.left = popupStartLeft + dx + "px";
      legendPopup.style.top = popupStartTop + dy + "px";
    });
    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        legendHeader.style.cursor = "grab";
      }
    });
  })();
  (function setupPkgDropdown() {
    const pkgBtn = document.getElementById("pkg-dropdown-btn");
    const pkgMenu = document.getElementById("pkg-dropdown-menu");
    if (!pkgBtn || !pkgMenu) return;
    pkgBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pkgMenu.classList.toggle("show");
      if (viewDropdownMenu) viewDropdownMenu.classList.remove("show");
    });
  })();
  var exportBtn = document.getElementById("export-btn");
  var exportMenu = document.getElementById("export-menu");
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isVisible = exportMenu.classList.contains("show");
    if (!isVisible) {
      const btnRect = exportBtn.getBoundingClientRect();
      const menuWidth = 160;
      const menuHeight = 200;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = btnRect.right - menuWidth;
      let top = btnRect.bottom + 4;
      if (left < 8) left = btnRect.left;
      if (left + menuWidth > viewportWidth - 8) left = viewportWidth - menuWidth - 8;
      if (top + menuHeight > viewportHeight - 8) top = btnRect.top - menuHeight - 4;
      exportMenu.style.left = left + "px";
      exportMenu.style.top = top + "px";
    }
    exportMenu.classList.toggle("show", !isVisible);
  });
  document.addEventListener("click", (e) => {
    if (!exportBtn.contains(e.target) && !exportMenu.contains(e.target)) {
      exportMenu.classList.remove("show");
    }
    if (viewDropdownBtn && viewDropdownMenu && !viewDropdownBtn.contains(e.target) && !viewDropdownMenu.contains(e.target)) {
      viewDropdownMenu.classList.remove("show");
    }
    const pkgBtn = document.getElementById("pkg-dropdown-btn");
    const pkgMenu = document.getElementById("pkg-dropdown-menu");
    if (pkgBtn && pkgMenu && !pkgBtn.contains(e.target) && !pkgMenu.contains(e.target)) {
      pkgMenu.classList.remove("show");
    }
  });
  document.querySelectorAll(".export-menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      const format = e.target.getAttribute("data-format");
      const scale = parseInt(e.target.getAttribute("data-scale")) || 2;
      if (format === "png-parent") {
        e.stopPropagation();
        return;
      }
      exportMenu.classList.remove("show");
      switch (format) {
        case "png":
          exportHandler.exportPNG(scale);
          break;
        case "svg":
          exportHandler.exportSVG();
          break;
        case "pdf":
          console.warn("PDF export not implemented");
          break;
        case "json":
          exportHandler.exportJSON();
          break;
      }
    });
  });

  // src/visualization/webview/index.ts
  var vscode2 = acquireVsCodeApi();
  initializeOrchestrator(vscode2);
})();
//# sourceMappingURL=visualizer.js.map
