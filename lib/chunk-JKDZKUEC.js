import {
  ACP_SESSION,
  foldNativeSession,
  nativeSessionSchema
} from "./chunk-5I4WLZ2F.js";

// src/google-acp-state.ts
import { z } from "zod";
var ACP_PROVIDER = "google-acp";
var ACP_EVENT = "plugin:yu-google-acp/update";
var ACP_PROJECTION = "yuGoogleAcp";
var ACP_BINDING = "plugin:yu-google-acp/binding";
var ACP_MESSAGE = "plugin:yu-google-acp/message";
var acpEventType = (type) => type.startsWith("yu-google-acp/") ? `plugin:${type}` : type;
var bindingSchema = z.object({
  owner: z.string(),
  nativeSessionId: z.string(),
  anchor: z.string().nullable(),
  historyHash: z.string(),
  promptPolicy: z.string().optional(),
  credentialStore: z.enum(["auto", "file"]).optional(),
  bad: z.boolean(),
  steered: z.array(z.object({ id: z.string(), hash: z.string() })).optional()
});
var nativeToolSchema = z.object({
  id: z.string(),
  nativeSessionId: z.string(),
  turn: z.number(),
  step: z.number().default(1),
  title: z.string(),
  status: z.string(),
  origin: z.enum(["Antigravity", "DSH \xB7 MCP"]),
  kind: z.string().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  meta: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
  locations: z.array(z.unknown()).optional(),
  permission: z.object({
    outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]),
    source: z.enum(["session-preset", "approval-service"]),
    preset: z.string().optional(),
    message: z.string()
  }).optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().optional()
});
function foldAcpState(state, event) {
  const type = acpEventType(event.type);
  if (type === ACP_BINDING)
    return {
      ...state,
      ...event.data?.reset === true || event.data === null ? { native: null } : {},
      binding: event.data?.reset === true || event.data === null ? null : bindingSchema.parse(event.data)
    };
  if (type === ACP_SESSION)
    return { ...state, native: foldNativeSession(state.native, event.data) };
  if (type === ACP_EVENT) {
    const call = nativeToolSchema.parse(event.data);
    const index = state.calls.findIndex(
      (c) => c.id === call.id && c.nativeSessionId === call.nativeSessionId && c.turn === call.turn && c.step === call.step
    );
    const calls2 = [...state.calls];
    if (index < 0) calls2.push(call);
    else calls2[index] = call;
    return { ...state, calls: calls2, runningTurn: call.turn };
  }
  if (event.type !== "turn/end") return state;
  const turn = event.data.turn;
  const status = event.data.reason?.kind === "completed" ? "incomplete" : "cancelled";
  let changed = state.runningTurn === turn;
  const calls = state.calls.map((c) => {
    if (c.turn !== turn || c.endedAt !== void 0) return c;
    changed = true;
    return { ...c, status, endedAt: event.time, updatedAt: event.time };
  });
  return changed ? {
    ...state,
    calls,
    runningTurn: state.runningTurn === turn ? null : state.runningTurn
  } : state;
}
var acpProjection = {
  key: ACP_PROJECTION,
  stateVersion: 2,
  stateSchema: z.object({
    calls: z.array(nativeToolSchema),
    runningTurn: z.number().nullable(),
    binding: bindingSchema.nullable(),
    native: nativeSessionSchema.nullable()
  }),
  init: () => ({
    calls: [],
    runningTurn: null,
    binding: null,
    native: null
  }),
  apply: foldAcpState,
  wire: {
    viewSchema: z.object({
      calls: z.array(nativeToolSchema),
      runningTurn: z.number().nullable(),
      native: nativeSessionSchema.nullable()
    }),
    view: (state) => ({
      calls: state.calls,
      runningTurn: state.runningTurn,
      native: state.native
    }),
    summary: false
  }
};
var TERMINAL_TOOL_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "cancelled",
  "incomplete"
]);
function isTerminalToolStatus(status) {
  return typeof status === "string" && TERMINAL_TOOL_STATUSES.has(status);
}
var isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function isDaemonToolCall(call) {
  return isPlainObject(call.rawInput) && call.rawInput.IsDaemon === true;
}
function isWaitableBackgroundCall(call) {
  if (call.origin !== "Antigravity" || call.status !== "in_progress" || call.endedAt !== void 0 || isDaemonToolCall(call))
    return false;
  const input = call.rawInput;
  if (!isPlainObject(input)) return false;
  if (call.kind === "execute" && (typeof input.CommandLine === "string" || typeof input.command === "string"))
    return true;
  if (typeof input.Script === "string" || typeof input.ScriptPath === "string")
    return true;
  if (typeof input.DurationSeconds === "number") return true;
  return false;
}
function bounded(value) {
  const encoded = JSON.stringify(value);
  if (encoded === void 0) return void 0;
  return encoded.length <= 128 * 1024 ? JSON.parse(encoded) : { truncated: true, preview: encoded.slice(0, 128 * 1024) };
}
var NativeToolRecorder = class {
  constructor(session, nativeSessionId, turn, writeRecord, step = 1) {
    this.session = session;
    this.nativeSessionId = nativeSessionId;
    this.turn = turn;
    this.writeRecord = writeRecord;
    this.step = step;
  }
  session;
  nativeSessionId;
  turn;
  writeRecord;
  step;
  calls = /* @__PURE__ */ new Map();
  update(update, origin = "Antigravity") {
    if (typeof update.toolCallId !== "string") return;
    const now = Date.now();
    const old = this.calls.get(update.toolCallId);
    const call = {
      id: update.toolCallId,
      nativeSessionId: this.nativeSessionId,
      turn: this.turn,
      step: this.step,
      title: update.title ?? old?.title ?? "ACP tool",
      status: update.status ?? old?.status ?? "pending",
      origin,
      startedAt: old?.startedAt ?? now,
      updatedAt: now,
      ...old ?? {}
    };
    call.updatedAt = now;
    if (origin === "DSH \xB7 MCP" || old?.origin === "DSH \xB7 MCP")
      call.origin = "DSH \xB7 MCP";
    for (const key of ["title", "status", "kind"])
      if (typeof update[key] === "string")
        call[key] = update[key].length > 4096 ? update[key].slice(0, 4096) + " [truncated]" : update[key];
    for (const key of ["rawInput", "rawOutput"])
      if (update[key] !== void 0) call[key] = bounded(update[key]);
    if (update._meta !== void 0) call.meta = bounded(update._meta);
    if (update.permission !== void 0)
      call.permission = nativeToolSchema.shape.permission.parse(
        update.permission
      );
    for (const key of ["content", "locations"])
      if (Array.isArray(update[key])) {
        call[key] = update[key].slice(0, 256).map(bounded);
        if (update[key].length > 256)
          call[key].push({
            truncated: true,
            omittedEntries: update[key].length - 256
          });
      }
    if (isTerminalToolStatus(call.status)) call.endedAt ??= now;
    else delete call.endedAt;
    this.calls.set(call.id, call);
    this.writeRecord(ACP_EVENT, { ...call, step: this.step });
    return call;
  }
  hasActiveBackgroundCalls() {
    return [...this.calls.values()].some(isWaitableBackgroundCall);
  }
  hasUnsettledCalls() {
    return [...this.calls.values()].some(
      (c) => c.endedAt === void 0 && !isDaemonToolCall(c)
    );
  }
  finish(status) {
    for (const call of this.calls.values())
      if (call.endedAt === void 0)
        this.update({ toolCallId: call.id, status });
  }
};
var NativeMessageRecorder = class {
  constructor(session, nativeSessionId, turn, step, writeRecord) {
    this.session = session;
    this.nativeSessionId = nativeSessionId;
    this.turn = turn;
    this.step = step;
    this.writeRecord = writeRecord;
  }
  session;
  nativeSessionId;
  turn;
  step;
  writeRecord;
  index = 0;
  current;
  tools = /* @__PURE__ */ new Set();
  append(data) {
    this.writeRecord(ACP_MESSAGE, {
      nativeSessionId: this.nativeSessionId,
      turn: this.turn,
      step: this.step,
      ...data
    });
  }
  delta(kind, text) {
    if (!text) return;
    if (this.current?.kind !== kind) {
      this.finish();
      this.current = { id: ++this.index, kind };
    }
    this.append({ ...this.current, delta: text });
  }
  tool(id) {
    if (typeof id !== "string" || this.tools.has(id)) return;
    this.tools.add(id);
    this.finish();
  }
  finish(status = "settled") {
    if (!this.current) return;
    this.append({ ...this.current, end: status });
    this.current = void 0;
  }
};

export {
  ACP_PROVIDER,
  ACP_EVENT,
  ACP_PROJECTION,
  ACP_BINDING,
  ACP_MESSAGE,
  acpEventType,
  bindingSchema,
  nativeToolSchema,
  foldAcpState,
  acpProjection,
  isTerminalToolStatus,
  isDaemonToolCall,
  isWaitableBackgroundCall,
  NativeToolRecorder,
  NativeMessageRecorder
};
//# sourceMappingURL=chunk-JKDZKUEC.js.map
