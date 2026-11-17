import { hostModule } from "./google-acp-records.js";
const { BasicCompactionEngine } = await hostModule(
  "@deepseek-ai/dsh-compaction-basic",
);

export const isGoogleAcp = (agent: any) =>
  (agent.model?.current()?.provider ?? agent.options?.provider) ===
  "google-acp";

/** Native agent history is opaque; host summaries must never replace its surface. */
export default class GoogleAcpCompaction extends BasicCompactionEngine {
  compactIfNeeded(agent: any, trigger: any, signal: AbortSignal) {
    return isGoogleAcp(agent)
      ? Promise.resolve(null)
      : super.compactIfNeeded(agent, trigger, signal);
  }
  compactNow(agent: any, signal: AbortSignal, commandId?: any): Promise<any> {
    if (isGoogleAcp(agent))
      return Promise.reject(new Error("请使用 /compact 调用官方 ACP 压缩。"));
    return super.compactNow(agent, signal, commandId);
  }
  compactRegion(
    start: any,
    end: any,
    agent: any,
    signal?: AbortSignal,
  ): Promise<any> {
    if (isGoogleAcp(agent))
      return Promise.reject(new Error("官方 ACP 不支持选择本地历史范围压缩。"));
    return super.compactRegion(start, end, agent, signal);
  }
}
