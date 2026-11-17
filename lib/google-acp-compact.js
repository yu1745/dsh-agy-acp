import {
  isGoogleAcp
} from "./chunk-B34D5BQA.js";
import {
  hostModule
} from "./chunk-S5DQ3W3J.js";

// src/google-acp-compact.ts
var name = "yu-google-acp-compact";
var inject = ["commands", "compaction"];
async function apply(ctx) {
  const { apply: applyCompact } = await hostModule(
    "@deepseek-ai/dsh-command-compact"
  );
  const commands = new Proxy(ctx.commands, {
    get(target, key) {
      if (key !== "register") return Reflect.get(target, key);
      return (definition) => target.register({
        ...definition,
        handler: async (invocation) => {
          if (!isGoogleAcp(invocation.agent))
            return definition.handler(invocation);
          if (invocation.rawInput.trim())
            return { kind: "error", text: "\u7528\u6CD5\uFF1A/compact\uFF08\u65E0\u53C2\u6570\uFF09" };
          try {
            const adapter = ctx.get("yuGoogleAcp");
            if (!adapter) throw new Error("\u5B98\u65B9 ACP \u63D2\u4EF6\u5F53\u524D\u4E0D\u53EF\u7528\u3002");
            return await adapter.compact(invocation.agent, invocation.signal);
          } catch (error) {
            return {
              kind: "error",
              text: invocation.signal.aborted ? "\u538B\u7F29\u5DF2\u53D6\u6D88\u3002" : error instanceof Error ? error.message : String(error)
            };
          }
        }
      });
    }
  });
  return applyCompact(
    new Proxy(ctx, {
      get(target, key) {
        return key === "commands" ? commands : Reflect.get(target, key);
      }
    })
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=google-acp-compact.js.map
