import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: [
    new URL("../src/google-acp-client.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const {
  acpCallDefinition,
  acpToolBlock,
  acpMessageDefinition,
  acpFlowDefinition,
  acpNoticeDefinition,
  installAcpFlowFilter,
  installGoogleAcpCalls,
  startAcpNotice,
  filterAcpPendingInputs,
  installAcpPendingFilter,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const event = (id, status, seq = 1, turn = 1) => ({
  type: "plugin:yu-google-acp/update",
  seq,
  time: seq,
  data: {
    id,
    nativeSessionId: "native",
    turn,
    step: 1,
    title: "Read probe.txt",
    kind: "read",
    status,
    origin: "Antigravity",
    rawInput: { path: "probe.txt" },
    rawOutput: "result",
    startedAt: 1,
    updatedAt: seq,
  },
});
const context = (definition, first) => ({
  id: definition.match[first.type](first).id,
  key: "stable-key",
  start: { event: first, location: { kind: "turn", turn: { turn: 1 } } },
  matches: [],
  state: definition.start({}, { event: first }),
});

test("ACP calls reuse the native tool renderer, retain their first position, and distinguish reused IDs", () => {
  const first = event("one", "in_progress", 3);
  const ctx = context(acpCallDefinition, first);
  const pending = acpCallDefinition.buildViewNode(ctx);
  ctx.state = acpCallDefinition.update(ctx, {
    event: event("one", "completed", 7),
  });
  const completed = acpCallDefinition.buildViewNode(ctx);
  assert.equal(pending.kind, "tool-call");
  assert.equal(pending.data.root.phase, "start");
  assert.equal(completed.data.root.kind, "tool-result");
  assert.equal(completed.data.root.name, "read");
  assert.equal(completed.key, pending.key);
  assert.equal(completed.anchorSeq, 3);
  assert.notEqual(
    ctx.id,
    acpCallDefinition.match[first.type](event("one", "completed", 9, 2)).id,
  );
});
test("terminal presentation preserves command, output, native metadata and permission without changing the input", () => {
  const call = {
    ...event("terminal", "completed").data,
    kind: "execute",
    title: "printf hello",
    rawInput: { CommandLine: "printf hello", toolSummary: "Print hello" },
    rawOutput: {
      output: '<script>alert("not executed")</script>',
      exit_code: 7,
    },
    permission: {
      outcome: "allowed-once",
      source: "session-preset",
      message: "Existing grant",
    },
    meta: { native: "retained" },
  };
  const before = structuredClone(call);
  const block = acpToolBlock(call, 7);
  assert.equal(block.name, "bash");
  assert.equal(JSON.parse(block.call.argsRaw).command, "printf hello");
  assert.match(block.content[0].text, /\[exit code: 7\]$/);
  assert(block.content[0].text.includes(call.rawOutput.output));
  assert.deepEqual(block.meta.acp.permission, call.permission);
  assert.deepEqual(block.meta.acp.nativeMeta, call.meta);
  assert.deepEqual(call, before);
  call.rawOutput = { output: "No exit status was returned" };
  const unknownExit = acpToolBlock(call, 8);
  assert.equal(JSON.parse(unknownExit.call.argsRaw).description, undefined);
  assert(!unknownExit.content[0].text.includes("[exit code:"));
  call.status = "failed";
  call.permission = {
    outcome: "rejected",
    source: "approval-service",
    message: "审批拒绝，命令未执行。",
  };
  assert(
    acpToolBlock(call, 8).content.some((c) =>
      c.text.includes(call.permission.message),
    ),
  );
});
test("searches show actual returned sources and explain when ACP omits the result", () => {
  const call = {
    ...event("search", "completed").data,
    kind: "search",
    rawInput: { query: "docs" },
    rawOutput: undefined,
  };
  const missing = acpToolBlock(call, 8);
  assert.equal(missing.name, "web_search");
  assert.deepEqual(JSON.parse(missing.call.argsRaw), { queries: ["docs"] });
  assert.match(missing.content[0].text, /未回传/);
  assert.equal(missing.meta.sources, undefined);
  call.meta = {
    sources: [
      {
        url: "https://docs.python.org/",
        title: "Python docs",
        snippet: "Reference",
      },
    ],
    answer: "Official documentation",
  };
  const returned = acpToolBlock(call, 9);
  assert.equal(returned.meta.sources[0].url, "https://docs.python.org/");
  assert.equal(returned.meta.answer, "Official documentation");
  call.meta = { sources: [{ url: "javascript:alert(1)" }] };
  assert.equal(acpToolBlock(call, 10).meta.sources, undefined);
});
test("native file diffs retain both versions without executing a file tool", () => {
  const call = {
    ...event("edit", "completed").data,
    kind: "edit",
    content: [{ type: "diff", path: "/tmp/a", oldText: "old", newText: "new" }],
  };
  assert.deepEqual(acpToolBlock(call, 3).meta.diffs, [
    { path: "/tmp/a", oldText: "old", newText: "new" },
  ]);
});
test("text segments keep a stable anchor while streaming and settling after a tool", () => {
  const first = {
    type: "plugin:yu-google-acp/message",
    seq: 10,
    time: 1,
    data: {
      nativeSessionId: "native",
      turn: 1,
      step: 1,
      id: 2,
      kind: "text",
      delta: "after tool",
    },
  };
  const ctx = context(acpMessageDefinition, first);
  const live = acpMessageDefinition.buildViewNode(ctx);
  assert.equal(live.kind, "assistant-step");
  assert.equal(live.data.status, "running");
  assert.equal(live.anchorSeq, 10);
  ctx.state = acpMessageDefinition.update(ctx, {
    event: { ...first, seq: 13, data: { ...first.data, delta: " continued" } },
  });
  ctx.state = acpMessageDefinition.update(ctx, {
    event: {
      ...first,
      seq: 15,
      data: { ...first.data, delta: undefined, end: "settled" },
    },
  });
  const done = acpMessageDefinition.buildViewNode(ctx);
  assert.equal(done.anchorSeq, 10);
  assert.equal(done.data.status, "settled");
  assert.equal(done.data.blocks[0].text, "after tool continued");
});
test("the host full-message filter is limited to marked ACP steps and restores on unload", () => {
  const native = { kind: "assistant-step", buildViewNode: () => "native" };
  const original = native.buildViewNode;
  const stop = installAcpFlowFilter({
    uiConversation: {
      events: { entries: () => [native], subscribe: () => () => {} },
    },
  });
  assert.equal(
    native.buildViewNode({
      start: {
        location: { kind: "step", step: { data: { get: () => undefined } } },
      },
    }),
    "native",
  );
  assert.equal(
    native.buildViewNode({
      start: {
        location: { kind: "step", step: { data: { get: () => true } } },
      },
    }),
    null,
  );
  stop();
  assert.equal(native.buildViewNode, original);
});
test("registration adds only ACP projections and leaves native tool slots owned by DSH", () => {
  const entries = [];
  const ctx = {
    inject: (names, cb) => (names.every((n) => ctx[n]) ? cb(ctx) : undefined),
    effect: (cb) => cb(),
    uiConversation: {
      events: {
        entries: () => entries,
        subscribe: () => () => {},
        register: (entry) => entries.push(entry),
      },
    },
  };
  installGoogleAcpCalls(ctx);
  assert.deepEqual(
    entries.map((e) => e.kind),
    [
      acpCallDefinition.kind,
      acpFlowDefinition.kind,
      acpMessageDefinition.kind,
      acpNoticeDefinition.kind,
    ],
  );
  assert.equal(
    entries[0].match["yu-google-acp/update"],
    entries[0].match["plugin:yu-google-acp/update"],
  );
});

test("MCP web reader reuses the native fetch presentation and unwraps the actual MCP text result", () => {
  const call = {
    ...event("reader", "completed").data,
    origin: "DSH · MCP",
    title: "google-acp-extensions/web_reader",
    kind: "other",
    rawInput: { url: "https://example.com/" },
    rawOutput: {
      content: [{ type: "text", text: "# Actual article\n\nPage content" }],
    },
  };
  const block = acpToolBlock(call, 8);
  assert.equal(block.name, "web_fetch");
  assert.equal(JSON.parse(block.call.argsRaw).url, "https://example.com/");
  assert.deepEqual(block.content, [
    { type: "text", text: "# Actual article\n\nPage content" },
  ]);
});

test("native notices render as display-only timeline messages", () => {
  const first = {
    type: "plugin:yu-google-acp/notice",
    seq: 4,
    time: 5,
    data: {
      id: "n",
      turn: 1,
      step: 1,
      title: "Warning",
      description: "Native detail",
      severity: "warning",
    },
  };
  const node = acpNoticeDefinition.buildViewNode(
    context(acpNoticeDefinition, first),
  );
  assert.equal(node.kind, "assistant-step");
  assert.equal(
    node.data.blocks[0].text,
    "Antigravity · Warning\n\nNative detail",
  );
});

test("submitted steering becomes an anchored native user bubble, including old records", () => {
  const message = {
    id: "m1",
    source: { kind: "user", rpcId: "rpc1" },
    content: [{ type: "text", text: "steer here" }],
  };
  const pending = {
    kind: "splice",
    previous: { kind: "snapshot", ids: [] },
    start: 0,
    removedCount: 0,
    inserted: [message],
  };
  const original = structuredClone(pending);
  const first = {
    type: "plugin:yu-google-acp/notice",
    seq: 12,
    time: 100,
    data: { id: "steer:m1", turn: 1, step: 1, title: "Submitted" },
  };
  const reader = {
    previous: (kind) =>
      kind === "inbox-next-step" ? { state: { pending } } : undefined,
  };
  const state = startAcpNotice({}, { event: first }, reader);
  const ctx = { ...context(acpNoticeDefinition, first), state };
  const bubble = acpNoticeDefinition.buildViewNode(ctx);
  assert.equal(bubble.kind, "steering");
  assert.equal(bubble.groupTree, "turn");
  assert.equal(bubble.anchorSeq, 12);
  assert.equal(bubble.data.messageId, "m1");
  assert.deepEqual(bubble.data.content, message.content);
  assert.deepEqual(pending, original);
  assert.equal(acpNoticeDefinition.buildViewNode(ctx).anchorSeq, 12);
  const later = startAcpNotice(
    {},
    { event: { data: { id: "warning" } } },
    {
      previous: (kind) =>
        kind === "yu-google-acp-notice" ? { state } : undefined,
    },
  );
  assert(later.delivered.has("m1"));
  const missing = startAcpNotice({}, { event: first });
  assert.equal(missing.delivered.size, 0);
  assert.equal(
    acpNoticeDefinition.buildViewNode({ ...ctx, state: missing }).kind,
    "assistant-step",
  );
  const inputs = [
    message,
    { requestId: "rpc1" },
    { id: "queued", source: { kind: "user", rpcId: "rpc2" } },
  ];
  const before = structuredClone(inputs);
  assert.deepEqual(filterAcpPendingInputs(inputs, [bubble]), [inputs[2]]);
  assert.deepEqual(filterAcpPendingInputs(inputs, []), inputs);
  assert.deepEqual(inputs, before);
});

test("later host admission hides only submitted ACP message IDs and restores hooks", () => {
  const entry = {
    kind: "input-message",
    start: (_ctx, match) => ({ messageId: match.event.data.id }),
    buildViewNode: (ctx) => ctx.state,
  };
  const originalStart = entry.start,
    originalBuild = entry.buildViewNode;
  const stop = installAcpFlowFilter({
    uiConversation: {
      events: { entries: () => [entry], subscribe: () => () => {} },
    },
  });
  const reader = {
    previous: () => ({ state: { delivered: new Set(["sent"]) } }),
  };
  const admitted = (id) => ({
    state: entry.start({}, { event: { data: { id } } }, reader),
  });
  assert.equal(entry.buildViewNode(admitted("sent")), null);
  assert.equal(entry.buildViewNode(admitted("queued")).messageId, "queued");
  stop();
  assert.equal(entry.start, originalStart);
  assert.equal(entry.buildViewNode, originalBuild);
});

test("flow filtering preserves the host component and restores it on unload", () => {
  const entry = { component: () => null };
  const original = entry.component;
  const stop = installAcpPendingFilter({
    slots: { entries: () => [entry], subscribe: () => () => {} },
  });
  const inputs = [{ id: "sent" }, { id: "queued" }];
  const node = { data: { messageId: "sent", yuGoogleAcpSteering: true } };
  const element = entry.component({
    pendingInputs: inputs,
    useChat: () => ({ nodes: { values: () => [node] } }),
  });
  assert.equal(element.type, original);
  assert.deepEqual(element.props.pendingInputs, [inputs[1]]);
  assert.equal(inputs.length, 2);
  stop();
  assert.equal(entry.component, original);
});
