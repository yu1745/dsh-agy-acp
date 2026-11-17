// src/google-acp-models.ts
import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
var effortOrder = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra",
  "max"
];
var effortNames = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  extra: "Extra",
  max: "Max"
};
function selectValues(options = []) {
  return options.flatMap(
    (option) => Array.isArray(option.options) ? selectValues(option.options) : [option]
  );
}
function groupAcpModels(session) {
  const models = session.models?.availableModels;
  if (!Array.isArray(models)) return [];
  const modelOption = session.configOptions?.find(
    (o) => o.category === "model" || o.id === "model"
  );
  const bases = new Map(
    selectValues(modelOption?.options).filter((o) => typeof o.value === "string").map((o) => [o.value, o.name ?? o.value])
  );
  const currentThought = session.configOptions?.find(
    (o) => o.id === "thought_level" || o.category === "thought_level"
  )?.currentValue;
  const groups = /* @__PURE__ */ new Map();
  for (const model of models) {
    if (typeof model.modelId !== "string" || !model.modelId) continue;
    const name = typeof model.name === "string" ? model.name : model.modelId;
    const suffix = /^(.*)-(off|none|minimal|low|medium|high|xhigh|extra|max)$/.exec(
      model.modelId
    );
    const label = /\s*\((off|none|minimal|low|medium|high|xhigh|extra|max)\)\s*$/i.exec(
      name
    );
    const grouped = suffix && suffix[1] && (bases.has(suffix[1]) || label?.[1].toLowerCase() === suffix[2]);
    const id = grouped ? suffix[1] : model.modelId;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: bases.get(id) ?? (grouped && label ? name.slice(0, label.index).trim() : name),
        variants: /* @__PURE__ */ new Map(),
        nativeIds: /* @__PURE__ */ new Set(),
        defaultNativeId: model.modelId
      };
      groups.set(id, group);
    }
    group.nativeIds.add(model.modelId);
    if (grouped) group.variants.set(suffix[2], model.modelId);
  }
  for (const group of groups.values()) {
    const current = session.models?.currentModelId;
    if (group.nativeIds.has(current)) group.defaultNativeId = current;
    else if (modelOption?.currentValue === group.id && group.variants.has(currentThought))
      group.defaultNativeId = group.variants.get(currentThought);
    else if (group.nativeIds.has(group.id)) group.defaultNativeId = group.id;
    else if (group.variants.has("medium"))
      group.defaultNativeId = group.variants.get("medium");
  }
  return [...groups.values()];
}
function acpReasoning(group, nativeDefault = group.defaultNativeId) {
  if (!group.variants.size) return void 0;
  const defaultEffort = [...group.variants].find(
    ([, id]) => id === nativeDefault
  )?.[0];
  return {
    efforts: [...group.variants.keys()].sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b)).map((id) => ({ id: ReasoningEffortId(id), name: effortNames[id] })),
    ...defaultEffort ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}
  };
}
function resolveAcpModelSelection(session, model, effort) {
  if (model === "default") {
    if (effort)
      throw new LlmError(
        "Select a model before choosing its thinking level.",
        "ACP_CONTROLS"
      );
    return void 0;
  }
  const group = groupAcpModels(session).find(
    (g) => g.id === model || g.nativeIds.has(model)
  );
  if (!group) {
    if (Array.isArray(session.models?.availableModels))
      throw new LlmError(
        "Selected model is not offered by the official ACP agent for this account.",
        "ACP_MODEL"
      );
    if (effort)
      throw new LlmError(
        "The official ACP agent did not advertise thinking levels for this model.",
        "ACP_CONTROLS"
      );
    return model;
  }
  if (effort) {
    const nativeId = group.variants.get(effort);
    if (!nativeId)
      throw new LlmError(
        "Selected thinking level is not offered by the official ACP agent for this model.",
        "ACP_CONTROLS"
      );
    return nativeId;
  }
  return group.nativeIds.has(model) ? model : group.defaultNativeId;
}

export {
  groupAcpModels,
  acpReasoning,
  resolveAcpModelSelection
};
//# sourceMappingURL=chunk-BEG4JNL7.js.map
