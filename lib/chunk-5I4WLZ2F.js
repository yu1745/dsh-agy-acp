// src/google-acp-session.ts
import { z } from "zod";
var ACP_SESSION = "plugin:yu-google-acp/session";
var ACP_NOTICE = "plugin:yu-google-acp/notice";
var nativeUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  cost: z.object({ amount: z.number().nonnegative(), currency: z.string() }).optional()
});
var nativeCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  input: z.object({ hint: z.string() }).optional()
});
var nativeSessionSchema = z.object({
  id: z.string(),
  usage: nativeUsageSchema.nullable().default(null),
  commands: z.array(nativeCommandSchema).nullable().default(null)
});
function foldNativeSession(previous, data) {
  if (typeof data?.nativeSessionId !== "string") return previous;
  const update = data.update;
  let state = previous && previous.id === data.nativeSessionId ? previous : { id: data.nativeSessionId, usage: null, commands: null };
  if (update?.sessionUpdate === "usage_update") {
    const parsed = nativeUsageSchema.safeParse(update);
    if (!parsed.success) return previous;
    state = { ...state, usage: parsed.data };
  } else if (update?.sessionUpdate === "available_commands_update") {
    const parsed = z.array(nativeCommandSchema).max(256).safeParse(update.availableCommands);
    if (!parsed.success) return previous;
    state = { ...state, commands: parsed.data };
  } else return previous;
  return state;
}
var NativeSessionUpdates = class {
  constructor(write, configUpdated) {
    this.write = write;
    this.configUpdated = configUpdated;
  }
  write;
  configUpdated;
  id;
  commands = null;
  pending = [];
  commandReady = () => {
  };
  ready = new Promise((resolve) => {
    this.commandReady = resolve;
  });
  compactions = /* @__PURE__ */ new Map();
  receive(params) {
    if (!this.id) {
      if ([
        "usage_update",
        "available_commands_update",
        "config_option_update",
        "current_mode_update"
      ].includes(params?.update?.sessionUpdate)) {
        if (this.pending.length >= 256) this.pending.shift();
        this.pending.push(params);
      }
      return;
    }
    if (params?.sessionId !== this.id) return;
    if (params.update?.sessionUpdate === "config_option_update")
      this.configUpdated?.(params.update);
    const next = foldNativeSession(null, {
      nativeSessionId: this.id,
      update: params.update
    });
    if (!next) return;
    this.write(ACP_SESSION, {
      nativeSessionId: this.id,
      update: next.commands !== null ? {
        sessionUpdate: "available_commands_update",
        availableCommands: next.commands
      } : { sessionUpdate: "usage_update", ...next.usage }
    });
    if (next.commands !== null) {
      this.commands = next.commands;
      this.commandReady();
    }
  }
  bind(id) {
    this.id = id;
    const pending = this.pending;
    this.pending = [];
    for (const params of pending) this.receive(params);
  }
  async requireCommand(name, signal) {
    signal.throwIfAborted();
    if (this.commands === null) {
      let timer;
      let abort = () => {
      };
      try {
        await Promise.race([
          this.ready,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("\u5B98\u65B9 ACP \u672A\u516C\u5E03\u53EF\u7528\u547D\u4EE4\uFF0C\u672A\u53D1\u9001\u538B\u7F29\u8BF7\u6C42\u3002")),
              5e3
            );
            abort = () => reject(signal.reason ?? new Error("Cancelled"));
            signal.addEventListener("abort", abort, { once: true });
          })
        ]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
    signal.throwIfAborted();
    if (!this.commands?.some((c) => c.name === name))
      throw new Error(`\u5B98\u65B9 ACP \u5F53\u524D\u672A\u63D0\u4F9B /${name}\uFF0C\u8BF7\u6C42\u672A\u53D1\u9001\u3002`);
  }
  /** Display compaction as a native activity; it never shadows local history. */
  compaction(update) {
    const id = update?.compactionId;
    if (typeof id !== "string" || !id || !["compaction_update", "compaction_summary_chunk"].includes(
      update.sessionUpdate
    ))
      return;
    const old = this.compactions.get(id) ?? {
      status: "in_progress",
      summary: []
    };
    const next = { ...old, summary: [...old.summary] };
    if (update.sessionUpdate === "compaction_update") {
      if (typeof update.status !== "string") return;
      next.status = update.status;
      if (update.summary === null) next.summary = [];
      else if (Array.isArray(update.summary))
        next.summary = update.summary.slice(0, 256);
      if (update.error === null) delete next.error;
      else if (typeof update.error === "string")
        next.error = update.error.slice(0, 4096);
    } else if (update.content && next.summary.length < 256)
      next.summary.push(update.content);
    this.compactions.set(id, next);
    return {
      toolCallId: `compaction:${id}`,
      title: "\u538B\u7F29\u4E0A\u4E0B\u6587",
      kind: "think",
      status: next.status,
      rawOutput: next.error ?? next.summary.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
    };
  }
  compactionFailure() {
    for (const entry of this.compactions.values())
      if (entry.status === "failed" || entry.status === "cancelled")
        return entry.error ?? `\u5B98\u65B9 ACP \u538B\u7F29${entry.status === "cancelled" ? "\u5DF2\u53D6\u6D88" : "\u5931\u8D25"}\u3002`;
  }
};

export {
  ACP_SESSION,
  ACP_NOTICE,
  nativeUsageSchema,
  nativeCommandSchema,
  nativeSessionSchema,
  foldNativeSession,
  NativeSessionUpdates
};
//# sourceMappingURL=chunk-5I4WLZ2F.js.map
