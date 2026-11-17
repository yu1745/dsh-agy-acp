import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";

const effortOrder = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra",
  "max",
];
const effortNames: Record<string, string> = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  extra: "Extra",
  max: "Max",
};
export type AcpModelGroup = {
  id: string;
  name: string;
  variants: Map<string, string>;
  nativeIds: Set<string>;
  defaultNativeId: string;
};

function selectValues(options: any[] = []): any[] {
  return options.flatMap((option) =>
    Array.isArray(option.options) ? selectValues(option.options) : [option],
  );
}

/** Group only variants actually advertised by the agent. A suffix alone is not a capability declaration. */
export function groupAcpModels(session: any): AcpModelGroup[] {
  const models = session.models?.availableModels;
  if (!Array.isArray(models)) return [];
  const modelOption = session.configOptions?.find(
    (o: any) => o.category === "model" || o.id === "model",
  );
  const bases = new Map<string, string>(
    selectValues(modelOption?.options)
      .filter((o) => typeof o.value === "string")
      .map((o) => [o.value, o.name ?? o.value]),
  );
  const currentThought = session.configOptions?.find(
    (o: any) => o.id === "thought_level" || o.category === "thought_level",
  )?.currentValue;
  const groups = new Map<string, AcpModelGroup>();
  for (const model of models) {
    if (typeof model.modelId !== "string" || !model.modelId) continue;
    const name = typeof model.name === "string" ? model.name : model.modelId;
    const suffix =
      /^(.*)-(off|none|minimal|low|medium|high|xhigh|extra|max)$/.exec(
        model.modelId,
      );
    const label =
      /\s*\((off|none|minimal|low|medium|high|xhigh|extra|max)\)\s*$/i.exec(
        name,
      );
    const grouped =
      suffix &&
      suffix[1] &&
      (bases.has(suffix[1]) || label?.[1].toLowerCase() === suffix[2]);
    const id = grouped ? suffix[1] : model.modelId;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name:
          bases.get(id) ??
          (grouped && label ? name.slice(0, label.index).trim() : name),
        variants: new Map(),
        nativeIds: new Set(),
        defaultNativeId: model.modelId,
      };
      groups.set(id, group);
    }
    group.nativeIds.add(model.modelId);
    if (grouped) group.variants.set(suffix[2], model.modelId);
  }
  for (const group of groups.values()) {
    const current = session.models?.currentModelId;
    if (group.nativeIds.has(current)) group.defaultNativeId = current;
    else if (
      modelOption?.currentValue === group.id &&
      group.variants.has(currentThought)
    )
      group.defaultNativeId = group.variants.get(currentThought)!;
    else if (group.nativeIds.has(group.id)) group.defaultNativeId = group.id;
    else if (group.variants.has("medium"))
      group.defaultNativeId = group.variants.get("medium")!;
  }
  return [...groups.values()];
}

export function acpReasoning(
  group: AcpModelGroup,
  nativeDefault = group.defaultNativeId,
) {
  if (!group.variants.size) return undefined;
  const defaultEffort = [...group.variants].find(
    ([, id]) => id === nativeDefault,
  )?.[0];
  return {
    efforts: [...group.variants.keys()]
      .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))
      .map((id) => ({ id: ReasoningEffortId(id), name: effortNames[id] })),
    ...(defaultEffort
      ? { defaultEffort: ReasoningEffortId(defaultEffort) }
      : {}),
  };
}

/** Resolve a grouped model + effort back to an exact native id; legacy variant ids keep working. */
export function resolveAcpModelSelection(
  session: any,
  model: string,
  effort?: string,
): string | undefined {
  if (model === "default") {
    if (effort)
      throw new LlmError(
        "Select a model before choosing its thinking level.",
        "ACP_CONTROLS",
      );
    return undefined;
  }
  const group = groupAcpModels(session).find(
    (g) => g.id === model || g.nativeIds.has(model),
  );
  if (!group) {
    if (Array.isArray(session.models?.availableModels))
      throw new LlmError(
        "Selected model is not offered by the official ACP agent for this account.",
        "ACP_MODEL",
      );
    if (effort)
      throw new LlmError(
        "The official ACP agent did not advertise thinking levels for this model.",
        "ACP_CONTROLS",
      );
    return model;
  }
  if (effort) {
    const nativeId = group.variants.get(effort);
    if (!nativeId)
      throw new LlmError(
        "Selected thinking level is not offered by the official ACP agent for this model.",
        "ACP_CONTROLS",
      );
    return nativeId;
  }
  return group.nativeIds.has(model) ? model : group.defaultNativeId;
}
