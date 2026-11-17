import type { TokenUsage } from "@deepseek-ai/dsh-llm";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** agy reports disjoint uncached input/cache counters in the prompt response.
 * Never derive completion tokens from context growth, text length or chunk count.
 */
export function acpTokenUsage(value: any): TokenUsage | undefined {
  if (!value || !count(value.inputTokens) || !count(value.outputTokens)) return;
  for (const field of [
    "cachedReadTokens",
    "cachedWriteTokens",
    "thoughtTokens",
    "totalTokens",
  ])
    if (value[field] !== undefined && !count(value[field])) return;
  if (
    value.thoughtTokens !== undefined &&
    value.thoughtTokens > value.outputTokens
  )
    return;
  const total =
    value.inputTokens +
    value.outputTokens +
    (value.cachedReadTokens ?? 0) +
    (value.cachedWriteTokens ?? 0);
  if (
    !count(total) ||
    (value.totalTokens !== undefined && value.totalTokens !== total)
  )
    return;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(value.totalTokens !== undefined
      ? { totalTokens: value.totalTokens }
      : {}),
    ...(value.cachedReadTokens !== undefined
      ? { cacheReadTokens: value.cachedReadTokens }
      : {}),
    ...(value.cachedWriteTokens !== undefined
      ? { cacheWriteTokens: value.cachedWriteTokens }
      : {}),
    ...(value.thoughtTokens !== undefined
      ? { reasoningTokens: value.thoughtTokens }
      : {}),
  };
}
