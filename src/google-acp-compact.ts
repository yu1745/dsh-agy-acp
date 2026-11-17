import { isGoogleAcp } from "./google-acp-compaction.js";
import { hostModule } from "./google-acp-records.js";

export const name = "yu-google-acp-compact";
export const inject = ["commands", "compaction"];

/** Keep the host's command lifecycle/validation and its exact non-ACP handler. */
export async function apply(ctx: any) {
  const { apply: applyCompact } = await hostModule(
    "@deepseek-ai/dsh-command-compact",
  );
  const commands = new Proxy(ctx.commands, {
    get(target, key) {
      if (key !== "register") return Reflect.get(target, key);
      return (definition: any) =>
        target.register({
          ...definition,
          handler: async (invocation: any) => {
            if (!isGoogleAcp(invocation.agent))
              return definition.handler(invocation);
            if (invocation.rawInput.trim())
              return { kind: "error", text: "用法：/compact（无参数）" };
            try {
              const adapter = ctx.get("yuGoogleAcp");
              if (!adapter) throw new Error("官方 ACP 插件当前不可用。");
              return await adapter.compact(invocation.agent, invocation.signal);
            } catch (error) {
              return {
                kind: "error",
                text: invocation.signal.aborted
                  ? "压缩已取消。"
                  : error instanceof Error
                    ? error.message
                    : String(error),
              };
            }
          },
        });
    },
  });
  return applyCompact(
    new Proxy(ctx, {
      get(target, key) {
        return key === "commands" ? commands : Reflect.get(target, key);
      },
    }),
  );
}
