import { PartialArguments } from "@deepseek-ai/dsh-util-values";
import { ACP_EVENT, ACP_MESSAGE, type NativeTool } from "./google-acp-state.js";
import { ACP_NOTICE } from "./google-acp-session.js";
import React, { useSyncExternalStore } from "react";

const FLOW_KEY = "yu-google-acp-flow";
const STEERING_KEY = "yuGoogleAcpSteering";
const settled = new Set(["completed", "failed", "cancelled", "incomplete"]);
const record = (value: any): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export const acpCallId = (call: NativeTool) =>
  `acp:${JSON.stringify([call.nativeSessionId, call.turn, call.step, call.id])}`;

/** Translate display data only. None of these names or arguments enter tool dispatch. */
export function acpToolBlock(call: NativeTool, seq: number) {
  const input = record(call.rawInput);
  const output = record(call.rawOutput);
  const nativeMeta = record(call.meta);
  const diffs = (call.content ?? []).filter(
    (b: any) =>
      b?.type === "diff" &&
      typeof b.path === "string" &&
      typeof b.newText === "string",
  ) as any[];
  const path =
    input.file_path ??
    input.path ??
    input.AbsolutePath ??
    input.absolute_path ??
    record(call.locations?.find((p: any) => typeof p?.path === "string")).path;
  let name = call.title;
  let args: Record<string, any> = input;
  let meta: Record<string, any> = {
    acp: {
      origin: call.origin,
      title: call.title,
      status: call.status,
      rawInput: call.rawInput,
      rawOutput: call.rawOutput,
      nativeMeta: call.meta,
      permission: call.permission,
    },
  };
  if (diffs.length)
    meta.diffs = diffs.map((d) => ({
      path: d.path,
      oldText: d.oldText ?? null,
      newText: d.newText,
    }));
  if (call.kind === "execute" && typeof input.CommandLine === "string") {
    name = "bash";
    args = {
      command: input.CommandLine,
      // The native terminal renderer assumes exit 0 for text without a marker.
      // Without an ACP exit status, use its generic shell-result body instead.
      ...(!settled.has(call.status) || Number.isInteger(output.exit_code)
        ? { description: input.toolSummary || call.title }
        : {}),
    };
    if (typeof input.Cwd === "string") args.workdir = input.Cwd;
  } else if (call.kind === "search" && typeof input.query === "string") {
    name = "web_search";
    args = { queries: [input.query] };
  } else if (call.kind === "read" && typeof path === "string") {
    name = "read";
    args = { ...input, file_path: path };
  } else if (diffs.length) {
    name = "apply_patch";
    args = { ...input, description: call.title };
  } else if (
    (call.kind === "fetch" ||
      (call.origin === "DSH · MCP" &&
        /(?:^|[/_])web_reader\b/.test(call.title))) &&
    typeof input.url === "string"
  ) {
    name = "web_fetch";
  }
  if (call.status === "waiting_approval" || call.status === "waiting_input")
    args = {
      ...args,
      description: `${call.status === "waiting_approval" ? "等待审批" : "等待选择"} · ${args.description ?? call.title}`,
    };
  const head = {
    callId: acpCallId(call),
    name,
    args: PartialArguments.fromObject(args),
    argsRaw: JSON.stringify(args),
    turn: call.turn,
    step: call.step,
    time: call.startedAt,
    subCalls: [],
  };
  if (!settled.has(call.status)) return { ...head, phase: "start" as const };

  let texts: string[] = [];
  for (const block of call.content ?? []) {
    const b: any = block;
    if (b?.type === "content" && b.content?.type === "text") {
      if (typeof b.content.text === "string" && b.content.text.trim())
        texts.push(b.content.text);
    } else if (b?.type === "content" && b.content?.type === "resource_link")
      texts.push(`${b.content.name ?? ""}\n${b.content.uri}`.trim());
    else if (b?.type !== "diff") texts.push(pretty(b));
  }
  if (!texts.length && Array.isArray(output.content)) {
    for (const block of output.content) {
      if (block?.type === "text" && typeof block.text === "string")
        texts.push(block.text);
      else if (block?.type === "image")
        texts.push(`已向原生代理返回图片（${block.mimeType ?? "image"}）。`);
    }
  }
  if (!texts.length && call.rawOutput !== undefined) {
    const text =
      typeof output.output === "string"
        ? output.output
        : pretty(call.rawOutput);
    if (text?.trim()) texts.push(text);
  }
  if (
    call.status !== "completed" &&
    call.permission?.outcome !== "allowed-once" &&
    call.permission?.message
  )
    texts.unshift(call.permission.message);
  if (name === "web_search") {
    // Only explicit source fields are admitted; never invent links from the query.
    const payload = { ...nativeMeta, ...output };
    const sources =
      output.sources ??
      output.results ??
      nativeMeta.sources ??
      nativeMeta.results;
    if (
      Array.isArray(sources) &&
      sources.every(
        (s: any) =>
          s && typeof s.url === "string" && /^https?:\/\//i.test(s.url),
      )
    ) {
      meta = {
        ...meta,
        truncated: payload.truncated === true,
        sources: sources.map((s: any) => ({
          url: s.url,
          ...(typeof s.title === "string" ? { title: s.title } : {}),
          ...(typeof s.snippet === "string" ? { snippet: s.snippet } : {}),
        })),
        ...(typeof payload.answer === "string"
          ? { answer: payload.answer }
          : {}),
      };
    } else if (!texts.length && call.status === "completed") {
      texts.push("官方 ACP 未回传这次搜索的结果正文或链接。");
    }
  }
  if (
    name === "bash" &&
    call.status === "completed" &&
    typeof output.exit_code === "number"
  )
    texts = [`${texts.join("\n")}\n[exit code: ${output.exit_code}]`];
  if (call.status === "incomplete") {
    texts.push("ACP 未返回工具的最终状态。");
  }
  return {
    kind: "tool-result" as const,
    seq,
    time: call.endedAt ?? call.updatedAt,
    callId: head.callId,
    name,
    args: head.args,
    call: { name, argsRaw: head.argsRaw },
    callTime: call.startedAt,
    subCalls: [],
    meta,
    content: texts.map((text) => ({ type: "text" as const, text })),
    isError: call.status !== "completed",
    ...(call.status === "cancelled"
      ? { error: { name: "AbortError", code: "ABORTED" } }
      : {}),
  };
}

export const acpCallDefinition = {
  kind: "yu-google-acp-call",
  target: "chat",
  match: {
    [ACP_EVENT]: (event: any) => ({
      id: acpCallId(event.data),
      role: "start",
      exclusive: true,
    }),
  },
  start: (_context: any, match: any) => match.event.data,
  update: (_context: any, match: any) => match.event.data,
  publication: () => "immediate",
  buildViewNode: (context: any) => {
    const first = context.start ?? context.matches[0];
    if (!first || !context.state) return null;
    return {
      key: context.key,
      kind: "tool-call",
      id: context.id,
      target: "chat",
      anchorSeq: first.event.seq,
      location: first.location,
      visibility: "visible",
      groupTree: "turn",
      data: { root: acpToolBlock(context.state, first.event.seq) },
    };
  },
};

export const acpFlowDefinition = {
  kind: FLOW_KEY,
  match: {
    [ACP_MESSAGE]: (event: any) => ({
      id: JSON.stringify([event.data.turn, event.data.step]),
      role: "start",
    }),
  },
  start: (_ctx: any, match: any) => ({
    turn: match.event.data.turn,
    step: match.event.data.step,
  }),
  update: (ctx: any) => ctx.state,
  buildLocationData: (ctx: any, scope: string) =>
    scope === "step"
      ? { kind: "step", ...ctx.state, key: FLOW_KEY, value: true }
      : null,
};
const segmentState = (previous: any, event: any) => ({
  ...event.data,
  text: (previous?.text ?? "") + (event.data.delta ?? ""),
  end: event.data.end,
  time: event.time,
  seq: event.seq,
});
export const acpMessageDefinition = {
  kind: "yu-google-acp-text",
  target: "chat",
  match: {
    [ACP_MESSAGE]: (event: any) => ({
      id: JSON.stringify([
        event.data.nativeSessionId,
        event.data.turn,
        event.data.step,
        event.data.id,
      ]),
      role: "start",
      exclusive: true,
    }),
  },
  start: (_ctx: any, match: any) => segmentState(undefined, match.event),
  update: (ctx: any, match: any) => segmentState(ctx.state, match.event),
  publication: () => "animation-frame",
  buildViewNode: (ctx: any) => {
    const first = ctx.start ?? ctx.matches[0];
    const s = ctx.state;
    if (!first || !s?.text?.trim()) return null;
    const blocks = [{ kind: s.kind, text: s.text }];
    return {
      key: ctx.key,
      kind: "assistant-step",
      id: ctx.id,
      target: "chat",
      anchorSeq: first.event.seq,
      location: first.location,
      visibility: "visible",
      groupTree: "turn",
      data: {
        turn: s.turn,
        step: s.step,
        blocks,
        time: first.event.time,
        status: s.end ?? "running",
        ...(s.end
          ? {
              finalNode: {
                kind: "assistant",
                seq: s.seq,
                time: s.time,
                turn: s.turn,
                step: s.step,
                blocks,
                ...(s.end === "interrupted" ? { interrupted: true } : {}),
              },
            }
          : {}),
      },
    };
  },
};

/** Reconstruct the host's immutable inbox splice chain at the submit event.
 * This also repairs presentation of records written before this UI fix. */
function pendingMessages(pending: any): any[] {
  const splices: any[] = [];
  let current = pending;
  while (current?.kind === "splice") {
    splices.push(current);
    current = current.previous;
  }
  let messages = current?.ids ?? [];
  for (const splice of splices.toReversed())
    messages = messages.toSpliced(
      splice.start,
      splice.removedCount,
      ...splice.inserted,
    );
  return messages;
}

export function startAcpNotice(_ctx: any, match: any, reader?: any) {
  const data = match.event.data;
  const delivered = new Set<string>(
    reader?.previous("yu-google-acp-notice")?.state.delivered ?? [],
  );
  const id =
    typeof data.id === "string" && data.id.startsWith("steer:")
      ? data.id.slice(6)
      : undefined;
  const message =
    id &&
    pendingMessages(reader?.previous("inbox-next-step")?.state.pending).find(
      (item: any) => item.id === id && item.source?.kind === "user",
    );
  // Never hide an inbox bubble unless its anchored replacement can be built.
  if (message) delivered.add(message.id);
  return { ...data, delivered, steering: message || undefined };
}

export const acpNoticeDefinition = {
  kind: "yu-google-acp-notice",
  target: "chat",
  match: {
    [ACP_NOTICE]: (event: any) => ({
      id: event.data.id,
      role: "start",
      exclusive: true,
    }),
  },
  start: startAcpNotice,
  update: (ctx: any) => ctx.state,
  publication: () => "immediate",
  buildViewNode: (ctx: any) => {
    const first = ctx.start ?? ctx.matches[0];
    const s = ctx.state;
    if (!first || !s) return null;
    if (s.steering)
      return {
        key: ctx.key,
        id: ctx.id,
        kind: "steering",
        target: "chat",
        anchorSeq: first.event.seq,
        location: first.location,
        visibility: "visible",
        groupTree: "turn",
        data: {
          kind: "steering",
          messageId: s.steering.id,
          content: s.steering.content,
          source: s.steering.source,
          seq: first.event.seq,
          time: first.event.time,
          batchStart: true,
          [STEERING_KEY]: true,
        },
      };
    const blocks = [
      {
        kind: "text",
        text: `Antigravity · ${s.title}${s.description ? `\n\n${s.description}` : ""}`,
      },
    ];
    return {
      key: ctx.key,
      id: ctx.id,
      kind: "assistant-step",
      target: "chat",
      anchorSeq: first.event.seq,
      location: first.location,
      visibility: "visible",
      groupTree: "turn",
      data: {
        turn: s.turn,
        step: s.step,
        blocks,
        time: first.event.time,
        status: "settled",
        finalNode: {
          kind: "assistant",
          seq: first.event.seq,
          time: first.event.time,
          turn: s.turn,
          step: s.step,
          blocks,
        },
      },
    };
  },
};

/** Native context length stays separate from the host's billing totals. */
export function AcpContextMeter({ useProjection, directory }: any) {
  const view = useProjection("yuGoogleAcp");
  const model: any = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot,
  );
  if (model.current?.provider !== "google-acp") return null;
  const usage = view?.native?.usage;
  if (!usage)
    return (
      <span style={{ fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
        上下文：等待上报
      </span>
    );
  const label = `上下文 ${(usage.used / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return (
    <span
      className="yu-acp-context-meter"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--dsw-alias-label-secondary)",
        fontVariantNumeric: "tabular-nums",
        flexWrap: "wrap",
      }}
    >
      <span>{label}</span>
      {usage.cost && (
        <span>
          · {usage.cost.amount} {usage.cost.currency}
        </span>
      )}
    </span>
  );
}

/** Only remove echoes backed by an actual anchored user node. Queue state,
 * editing, dispatch and non-ACP messages remain owned by the host. */
export function filterAcpPendingInputs(
  pending: readonly any[],
  nodes: readonly any[],
) {
  const ids = new Set<string>();
  const rpcIds = new Set<string>();
  for (const node of nodes) {
    if (!node?.data?.[STEERING_KEY]) continue;
    ids.add(node.data.messageId);
    if (typeof node.data.source?.rpcId === "string")
      rpcIds.add(node.data.source.rpcId);
  }
  return pending.filter(
    (item: any) =>
      !ids.has(item.id) &&
      !rpcIds.has(item.requestId) &&
      !rpcIds.has(item.source?.rpcId),
  );
}

/** The host has no flow decorator seat. Wrap its existing occupant so all its
 * injected hooks, store and child-slot ownership stay intact; undo on unload. */
export function installAcpPendingFilter(ctx: any) {
  const restored = new Map<any, { original: any; wrapped: any }>();
  const sync = () => {
    for (const entry of ctx.slots.entries("conversation.chat.flow")) {
      if (restored.has(entry) || !entry.component) continue;
      const original = entry.component;
      const wrapped = (props: any) => {
        const snapshot = props.useChat((value: any) => value);
        const pendingInputs = filterAcpPendingInputs(
          props.pendingInputs,
          snapshot.nodes.values(),
        );
        return React.createElement(original, { ...props, pendingInputs });
      };
      restored.set(entry, { original, wrapped });
      entry.component = wrapped;
    }
  };
  sync();
  const stop = ctx.slots.subscribe("conversation.chat.flow", sync);
  return () => {
    stop();
    for (const [entry, { original, wrapped }] of restored)
      if (entry.component === wrapped) entry.component = original;
  };
}

/** Keep the host's full message and footer metadata; only its duplicate chat node is hidden.
 * The registry exposes stable entries but no decorator API, so this narrow hook
 * is restored on unload and leaves every non-ACP step unchanged.
 */
export function installAcpFlowFilter(ctx: any) {
  const registry = ctx.uiConversation.events;
  const restored = new Map<any, { original: any; wrapped: any }>();
  const inputs = new Map<
    any,
    { start: any; build: any; wrappedStart: any; wrappedBuild: any }
  >();
  const sync = () => {
    for (const entry of registry.entries()) {
      if (entry.kind === "input-message" && !inputs.has(entry)) {
        const start = entry.start;
        const build = entry.buildViewNode;
        const wrappedStart = (context: any, match: any, reader: any) => {
          const state = start.call(entry, context, match, reader);
          const delivered = reader?.previous("yu-google-acp-notice")?.state
            .delivered;
          return state && delivered?.has(state.messageId)
            ? { ...state, [STEERING_KEY]: true }
            : state;
        };
        const wrappedBuild = (context: any) =>
          context.state?.[STEERING_KEY] ? null : build.call(entry, context);
        if (start && build) {
          inputs.set(entry, { start, build, wrappedStart, wrappedBuild });
          entry.start = wrappedStart;
          entry.buildViewNode = wrappedBuild;
        }
      }
      if (
        entry.kind !== "assistant-step" ||
        restored.has(entry) ||
        !entry.buildViewNode
      )
        continue;
      const original = entry.buildViewNode;
      const wrapped = (context: any) => {
        const location =
          context.start?.location ?? context.matches[0]?.location;
        if (location?.kind === "step" && location.step.data.get(FLOW_KEY))
          return null;
        return original.call(entry, context);
      };
      restored.set(entry, { original, wrapped });
      entry.buildViewNode = wrapped;
    }
  };
  sync();
  const stop = registry.subscribe(sync);
  return () => {
    stop();
    for (const [
      entry,
      { start, build, wrappedStart, wrappedBuild },
    ] of inputs) {
      if (entry.start === wrappedStart) entry.start = start;
      if (entry.buildViewNode === wrappedBuild) entry.buildViewNode = build;
    }
    for (const [entry, { original, wrapped }] of restored)
      if (entry.buildViewNode === wrapped) entry.buildViewNode = original;
  };
}
export function installGoogleAcpCalls(ctx: any) {
  ctx.inject(["slots"], (ready: any) =>
    ready.slots.inject("conversation.chat.flow", () =>
      installAcpPendingFilter(ready),
    ),
  );
  ctx.inject(["uiConversation"], (ready: any) => {
    ready.effect(() => installAcpFlowFilter(ready));
    for (const definition of [
      acpCallDefinition,
      acpFlowDefinition,
      acpMessageDefinition,
      acpNoticeDefinition,
    ]) {
      const match: Record<string, (event: any) => any> = {
        ...definition.match,
      };
      for (const [type, handler] of Object.entries(definition.match))
        match[type.replace(/^plugin:/, "")] = handler;
      ready.uiConversation.events.register({ ...definition, match });
    }
  });
  ctx.inject(["slots", "modelDirectories"], (ready: any) =>
    ready.slots.inject("conversation.composer.dock", () =>
      ready.slots.register(
        {
          name: "conversation.composer.dock",
          id: "yu-acp-context",
          order: 500,
        },
        (props: any) => (
          <AcpContextMeter
            {...props}
            directory={
              ready.modelDirectories.directoryFor(props.sessionId).store
            }
          />
        ),
      ),
    ),
  );
}
