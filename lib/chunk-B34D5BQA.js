import {
  hostModule
} from "./chunk-S5DQ3W3J.js";

// src/google-acp-compaction.ts
var { BasicCompactionEngine } = await hostModule(
  "@deepseek-ai/dsh-compaction-basic"
);
var isGoogleAcp = (agent) => (agent.model?.current()?.provider ?? agent.options?.provider) === "google-acp";
var GoogleAcpCompaction = class extends BasicCompactionEngine {
  compactIfNeeded(agent, trigger, signal) {
    return isGoogleAcp(agent) ? Promise.resolve(null) : super.compactIfNeeded(agent, trigger, signal);
  }
  compactNow(agent, signal, commandId) {
    if (isGoogleAcp(agent))
      return Promise.reject(new Error("\u8BF7\u4F7F\u7528 /compact \u8C03\u7528\u5B98\u65B9 ACP \u538B\u7F29\u3002"));
    return super.compactNow(agent, signal, commandId);
  }
  compactRegion(start, end, agent, signal) {
    if (isGoogleAcp(agent))
      return Promise.reject(new Error("\u5B98\u65B9 ACP \u4E0D\u652F\u6301\u9009\u62E9\u672C\u5730\u5386\u53F2\u8303\u56F4\u538B\u7F29\u3002"));
    return super.compactRegion(start, end, agent, signal);
  }
};

export {
  isGoogleAcp,
  GoogleAcpCompaction
};
//# sourceMappingURL=chunk-B34D5BQA.js.map
