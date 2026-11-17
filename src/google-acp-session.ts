import { z } from "zod";

export const ACP_SESSION = "plugin:yu-google-acp/session";
export const ACP_NOTICE = "plugin:yu-google-acp/notice";
export const nativeUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  cost: z
    .object({ amount: z.number().nonnegative(), currency: z.string() })
    .optional(),
});
export const nativeCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  input: z.object({ hint: z.string() }).optional(),
});
export const nativeSessionSchema = z.object({
  id: z.string(),
  usage: nativeUsageSchema.nullable().default(null),
  commands: z.array(nativeCommandSchema).nullable().default(null),
});
export type NativeSession = z.infer<typeof nativeSessionSchema>;

/** Context occupancy is a latest-value gauge, never a billable TokenUsage. */
export function foldNativeSession(
  previous: NativeSession | null,
  data: any,
): NativeSession | null {
  if (typeof data?.nativeSessionId !== "string") return previous;
  const update = data.update;
  let state: NativeSession =
    previous && previous.id === data.nativeSessionId
      ? previous
      : { id: data.nativeSessionId, usage: null, commands: null };
  if (update?.sessionUpdate === "usage_update") {
    const parsed = nativeUsageSchema.safeParse(update);
    if (!parsed.success) return previous;
    state = { ...state, usage: parsed.data };
  } else if (update?.sessionUpdate === "available_commands_update") {
    const parsed = z
      .array(nativeCommandSchema)
      .max(256)
      .safeParse(update.availableCommands);
    if (!parsed.success) return previous;
    state = { ...state, commands: parsed.data };
  } else return previous;
  return state;
}

/** One listener is installed before session setup, so eager metadata is not lost. */
export class NativeSessionUpdates {
  id?: string;
  commands: NativeSession["commands"] = null;
  private pending: any[] = [];
  private commandReady: () => void = () => {};
  private ready = new Promise<void>((resolve) => {
    this.commandReady = resolve;
  });
  private compactions = new Map<
    string,
    { status: string; summary: any[]; error?: string }
  >();
  constructor(
    private write: (type: string, data: any) => unknown,
    private configUpdated?: (update: any) => void,
  ) {}
  receive(params: any) {
    if (!this.id) {
      // Startup replay text and tools belong to the official agent's history.
      // Buffer metadata only; do not duplicate old chat content on resume.
      if (
        [
          "usage_update",
          "available_commands_update",
          "config_option_update",
          "current_mode_update",
        ].includes(params?.update?.sessionUpdate)
      ) {
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
      update: params.update,
    });
    if (!next) return;
    this.write(ACP_SESSION, {
      nativeSessionId: this.id,
      update:
        next.commands !== null
          ? {
              sessionUpdate: "available_commands_update",
              availableCommands: next.commands,
            }
          : { sessionUpdate: "usage_update", ...next.usage },
    });
    if (next.commands !== null) {
      this.commands = next.commands;
      this.commandReady();
    }
  }
  bind(id: string) {
    this.id = id;
    const pending = this.pending;
    this.pending = [];
    for (const params of pending) this.receive(params);
  }
  async requireCommand(name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.commands === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => {};
      try {
        await Promise.race([
          this.ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("官方 ACP 未公布可用命令，未发送压缩请求。")),
              5000,
            );
            abort = () => reject(signal.reason ?? new Error("Cancelled"));
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
    signal.throwIfAborted();
    if (!this.commands?.some((c) => c.name === name))
      throw new Error(`官方 ACP 当前未提供 /${name}，请求未发送。`);
  }
  /** Display compaction as a native activity; it never shadows local history. */
  compaction(update: any) {
    const id = update?.compactionId;
    if (
      typeof id !== "string" ||
      !id ||
      !["compaction_update", "compaction_summary_chunk"].includes(
        update.sessionUpdate,
      )
    )
      return;
    const old = this.compactions.get(id) ?? {
      status: "in_progress",
      summary: [],
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
      title: "压缩上下文",
      kind: "think",
      status: next.status,
      rawOutput:
        next.error ??
        next.summary
          .filter((c) => c?.type === "text")
          .map((c) => c.text)
          .join("\n"),
    };
  }
  compactionFailure() {
    for (const entry of this.compactions.values())
      if (entry.status === "failed" || entry.status === "cancelled")
        return (
          entry.error ??
          `官方 ACP 压缩${entry.status === "cancelled" ? "已取消" : "失败"}。`
        );
  }
}
