// src/google-acp-usage.ts
var count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function acpTokenUsage(value) {
  if (!value || !count(value.inputTokens) || !count(value.outputTokens)) return;
  for (const field of [
    "cachedReadTokens",
    "cachedWriteTokens",
    "thoughtTokens",
    "totalTokens"
  ])
    if (value[field] !== void 0 && !count(value[field])) return;
  if (value.thoughtTokens !== void 0 && value.thoughtTokens > value.outputTokens)
    return;
  const total = value.inputTokens + value.outputTokens + (value.cachedReadTokens ?? 0) + (value.cachedWriteTokens ?? 0);
  if (!count(total) || value.totalTokens !== void 0 && value.totalTokens !== total)
    return;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...value.totalTokens !== void 0 ? { totalTokens: value.totalTokens } : {},
    ...value.cachedReadTokens !== void 0 ? { cacheReadTokens: value.cachedReadTokens } : {},
    ...value.cachedWriteTokens !== void 0 ? { cacheWriteTokens: value.cachedWriteTokens } : {},
    ...value.thoughtTokens !== void 0 ? { reasoningTokens: value.thoughtTokens } : {}
  };
}

export {
  acpTokenUsage
};
//# sourceMappingURL=chunk-B4XHGPT4.js.map
