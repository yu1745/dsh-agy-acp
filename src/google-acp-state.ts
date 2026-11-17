import { z } from "zod";
import {
  ACP_SESSION,
  foldNativeSession,
  nativeSessionSchema,
  type NativeSession,
} from "./google-acp-session.js";

export const ACP_PROVIDER = "google-acp";
export const ACP_EVENT = "plugin:yu-google-acp/update";
export const ACP_PROJECTION = "yuGoogleAcp";
export const ACP_BINDING = "plugin:yu-google-acp/binding";
export const ACP_MESSAGE = "plugin:yu-google-acp/message";
export const acpEventType = (type: string) =>
  type.startsWith("yu-google-acp/") ? `plugin:${type}` : type;
export type AcpRecordWriter = (type: string, data: unknown) => unknown;
export const bindingSchema = z.object({
  owner: z.string(),
  nativeSessionId: z.string(),
  anchor: z.string().nullable(),
  historyHash: z.string(),
  promptPolicy: z.string().optional(),
  credentialStore: z.enum(["auto", "file"]).optional(),
  bad: z.boolean(),
  steered: z.array(z.object({ id: z.string(), hash: z.string() })).optional(),
});
export const nativeToolSchema = z.object({
  id: z.string(),
  nativeSessionId: z.string(),
  turn: z.number(),
  step: z.number().default(1),
  title: z.string(),
  status: z.string(),
  origin: z.enum(["Antigravity", "DSH · MCP"]),
  kind: z.string().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  meta: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
  locations: z.array(z.unknown()).optional(),
  permission: z
    .object({
      outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]),
      source: z.enum(["session-preset", "approval-service"]),
      preset: z.string().optional(),
      message: z.string(),
    })
    .optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().optional(),
});
export type NativeTool = z.infer<typeof nativeToolSchema>;
export type AcpState = {
  calls: NativeTool[];
  runningTurn: number | null;
  binding: z.infer<typeof bindingSchema> | null;
  native: NativeSession | null;
};

/** Merge partial ACP tool updates; ids are scoped to the native session. */
export function foldAcpState(state: AcpState, event: any): AcpState {
  const type = acpEventType(event.type);
  if (type === ACP_BINDING)
    return {
      ...state,
      ...(event.data?.reset === true || event.data === null
        ? { native: null }
        : {}),
      binding:
        event.data?.reset === true || event.data === null
          ? null
          : bindingSchema.parse(event.data),
    };
  if (type === ACP_SESSION)
    return { ...state, native: foldNativeSession(state.native, event.data) };
  if (type === ACP_EVENT) {
    const call = nativeToolSchema.parse(event.data);
    const index = state.calls.findIndex(
      (c) =>
        c.id === call.id &&
        c.nativeSessionId === call.nativeSessionId &&
        c.turn === call.turn &&
        c.step === call.step,
    );
    const calls = [...state.calls];
    if (index < 0) calls.push(call);
    else calls[index] = call;
    return { ...state, calls, runningTurn: call.turn };
  }
  if (event.type !== "turn/end") return state;
  const turn = event.data.turn;
  const status =
    event.data.reason?.kind === "completed" ? "incomplete" : "cancelled";
  let changed = state.runningTurn === turn;
  const calls = state.calls.map((c) => {
    if (c.turn !== turn || c.endedAt !== undefined) return c;
    changed = true;
    return { ...c, status, endedAt: event.time, updatedAt: event.time };
  });
  return changed
    ? {
        ...state,
        calls,
        runningTurn: state.runningTurn === turn ? null : state.runningTurn,
      }
    : state;
}

export const acpProjection = {
  key: ACP_PROJECTION,
  stateVersion: 2,
  stateSchema: z.object({
    calls: z.array(nativeToolSchema),
    runningTurn: z.number().nullable(),
    binding: bindingSchema.nullable(),
    native: nativeSessionSchema.nullable(),
  }),
  init: (): AcpState => ({
    calls: [],
    runningTurn: null,
    binding: null,
    native: null,
  }),
  apply: foldAcpState,
  wire: {
    viewSchema: z.object({
      calls: z.array(nativeToolSchema),
      runningTurn: z.number().nullable(),
      native: nativeSessionSchema.nullable(),
    }),
    view: (state: AcpState) => ({
      calls: state.calls,
      runningTurn: state.runningTurn,
      native: state.native,
    }),
    summary: false,
  },
};

function bounded(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  return encoded.length <= 128 * 1024
    ? JSON.parse(encoded)
    : { truncated: true, preview: encoded.slice(0, 128 * 1024) };
}

export class NativeToolRecorder {
  private calls = new Map<string, NativeTool>();
  constructor(
    private session: any,
    private nativeSessionId: string,
    private turn: number,
    private writeRecord: AcpRecordWriter,
    private step: number = 1,
  ) {}
  update(update: any, origin: NativeTool["origin"] = "Antigravity") {
    if (typeof update.toolCallId !== "string") return;
    const now = Date.now();
    const old = this.calls.get(update.toolCallId);
    const call: NativeTool = {
      id: update.toolCallId,
      nativeSessionId: this.nativeSessionId,
      turn: this.turn,
      step: this.step,
      title: update.title ?? old?.title ?? "ACP tool",
      status: update.status ?? old?.status ?? "pending",
      origin,
      startedAt: old?.startedAt ?? now,
      updatedAt: now,
      ...(old ?? {}),
    };
    call.updatedAt = now;
    if (origin === "DSH · MCP" || old?.origin === "DSH · MCP")
      call.origin = "DSH · MCP";
    for (const key of ["title", "status", "kind"] as const)
      if (typeof update[key] === "string")
        call[key] =
          update[key].length > 4096
            ? update[key].slice(0, 4096) + " [truncated]"
            : update[key];
    for (const key of ["rawInput", "rawOutput"] as const)
      if (update[key] !== undefined) call[key] = bounded(update[key]);
    if (update._meta !== undefined) call.meta = bounded(update._meta);
    if (update.permission !== undefined)
      call.permission = nativeToolSchema.shape.permission.parse(
        update.permission,
      );
    for (const key of ["content", "locations"] as const)
      if (Array.isArray(update[key])) {
        call[key] = update[key].slice(0, 256).map(bounded);
        if (update[key].length > 256)
          call[key]!.push({
            truncated: true,
            omittedEntries: update[key].length - 256,
          });
      }
    if (
      ["completed", "failed", "cancelled", "incomplete"].includes(call.status)
    )
      call.endedAt ??= now;
    this.calls.set(call.id, call);
    this.writeRecord(ACP_EVENT, { ...call, step: this.step });
    return call;
  }
  finish(status: "incomplete" | "cancelled" | "failed") {
    for (const call of this.calls.values())
      if (call.endedAt === undefined)
        this.update({ toolCallId: call.id, status });
  }
}

/** Durable display segments follow ACP arrival order, independently of the host model step. */
export class NativeMessageRecorder {
  private index = 0;
  private current?: { id: number; kind: "text" | "reasoning" };
  private tools = new Set<string>();
  constructor(
    private session: any,
    private nativeSessionId: string,
    private turn: number,
    private step: number,
    private writeRecord: AcpRecordWriter,
  ) {}
  private append(data: any) {
    this.writeRecord(ACP_MESSAGE, {
      nativeSessionId: this.nativeSessionId,
      turn: this.turn,
      step: this.step,
      ...data,
    });
  }
  delta(kind: "text" | "reasoning", text: string) {
    if (!text) return;
    if (this.current?.kind !== kind) {
      this.finish();
      this.current = { id: ++this.index, kind };
    }
    this.append({ ...this.current, delta: text });
  }
  tool(id: unknown) {
    if (typeof id !== "string" || this.tools.has(id)) return;
    this.tools.add(id);
    this.finish();
  }
  finish(status: "settled" | "interrupted" = "settled") {
    if (!this.current) return;
    this.append({ ...this.current, end: status });
    this.current = undefined;
  }
}
