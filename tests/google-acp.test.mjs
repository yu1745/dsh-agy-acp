import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoogleAcpAdapter,
  messagesAfterAnchor,
  buildAcpPrompt,
  apply,
  groupAcpModels,
  resolveAcpModelSelection,
} from "../lib/google-acp.js";
import {
  ACP_PROVIDER,
  ACP_EVENT,
  ACP_BINDING,
  acpProjection,
  NativeToolRecorder,
  ACP_MESSAGE,
} from "../lib/google-acp-state.js";
import { selectMcpTools, DshMcpBridge } from "../lib/google-acp-mcp.js";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { appendAcpRecord } from "../lib/google-acp-records.js";
import {
  ACP_SESSION,
  NativeSessionUpdates,
} from "../lib/google-acp-session.js";
import { acpTokenUsage } from "../lib/google-acp-usage.js";
const fixture = fileURLToPath(
  new URL("./fixtures/google-acp-agent.mjs", import.meta.url),
);
const cwd = fileURLToPath(new URL("..", import.meta.url));

function harness(scenario = "normal", mcpTools = [], credentialStore = "auto", quietMs = { normal: 35, continued: 160 }) {
  let state = acpProjection.init();
  const events = [],
    calls = [];
  const session = {
    id: "dsh-session",
    header: { cwd },
    append(type, data) {
      const event = {
        seq: events.length,
        time: Date.now(),
        type,
        data: structuredClone(data),
      };
      events.push(event);
      state = acpProjection.apply(state, event);
      return event;
    },
  };
  let maintenanceBusy = false;
  const maintenanceAbort = new AbortController();
  const agent = {
    id: session.id,
    session,
    status: "idle",
    model: { current: () => ({ provider: ACP_PROVIDER }) },
    runMaintenance(task) {
      if (maintenanceBusy || agent.status !== "idle")
        throw new Error("agent busy");
      maintenanceBusy = true;
      return Promise.resolve(task(maintenanceAbort.signal)).finally(() => {
        maintenanceBusy = false;
      });
    },
  };
  let toolSetDisposed = 0;
  const ctx = {
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      turnBoundaryOf: () => ({ lastTurn: 1 }),
    },
    emit() {},
    get: () => undefined,
    tools: {
      resolve: async () => ({ dispose: () => toolSetDisposed++ }),
      schemas: () => [
        {
          name: "weather",
          description: "Get local weather",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      execute: async (input) => {
        calls.push(input);
        return {
          results: [
            {
              result: {
                isError: false,
                content: [{ type: "text", text: "Sunny" }],
              },
            },
          ],
          additionalContexts: [],
        };
      },
    },
  };
  const adapter = new GoogleAcpAdapter(
    ctx,
    {
      command: process.execPath,
      args: [fixture, scenario],
      credentialStore,
      mcpTools,
      requestTimeoutMs: 5000,
    },
    { stateOf: () => state },
    (session, type, data) => session.append(type, data),
    quietMs,
  );
  const options = {
    provider: ACP_PROVIDER,
    model: "gemini-test-high",
    sessionId: agent.id,
    messages: [
      {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
  };
  return {
    adapter,
    ctx,
    agent,
    events,
    calls,
    options,
    state: () => state,
    disposed: () => toolSetDisposed,
    maintenanceAbort,
  };
}
async function modelCatalog(h) {
  await h.adapter.listModels(ACP_PROVIDER);
  while (h.adapter.catalogTask) await h.adapter.catalogTask;
  return h.adapter.listModels(ACP_PROVIDER);
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("steering reaches the active native turn, queue remains parked, and delivered input is never resent", async () => {
  const h = harness("steering");
  let inserted;
  h.ctx.on = (name, cb) => {
    if (name !== "agent/inbox/inserted") return () => {};
    inserted = cb;
    return () => {
      inserted = undefined;
    };
  };
  const steer = {
    id: "steer-1",
    role: "user",
    content: [{ type: "text", text: "STEER" }],
  };
  const queued = {
    id: "queued-1",
    role: "user",
    content: [{ type: "text", text: "QUEUE" }],
  };
  h.agent.inbox = { nextStep: [], nextTurn: [] };
  try {
    const stream = h.adapter.stream(h.options);
    assert.equal((await stream.next()).value.type, "block-start");
    assert.equal((await stream.next()).value.text, "RUNNING");
    h.agent.inbox.nextTurn.push(queued);
    inserted({ agent: h.agent, message: queued });
    h.agent.inbox.nextStep.push(steer);
    inserted({ agent: h.agent, message: steer });
    const chunks = await collect(stream);
    assert(chunks.some((c) => c.text === "STEER_RECEIVED"));
    assert.deepEqual(h.agent.inbox.nextTurn, [queued]);
    assert.equal(h.state().binding.bad, false);
    assert.equal(h.state().binding.steered[0].id, steer.id);
    assert.equal(inserted, undefined);
    h.adapter.connection = () => {
      throw new Error("delivered input must not be sent twice");
    };
    const ack = await collect(
      h.adapter.stream({
        ...h.options,
        messages: [...h.options.messages, steer],
      }),
    );
    assert.equal(ack.at(-1).reason.kind, "stop");
    assert.equal(h.state().binding.anchor, steer.id);
  } finally {
    h.adapter.dispose();
  }
});

test("an official ACP turn streams text and native tools without DSH dispatch or tool-call finishes", async () => {
  const h = harness();
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    assert.equal(chunks.at(-1).reason.kind, "stop");
    assert.equal(h.calls.length, 0);
    assert(
      !chunks.some(
        (c) => c.type === "tool-call-delta" || c.blockType === "tool-call",
      ),
    );
    const assembler = new BlockAssembler();
    chunks.forEach((c) => assembler.push(c));
    assert.deepEqual(assembler.blocks(), [
      { type: "reasoning", text: "Native reasoning" },
      { type: "text", text: "Starting. Done." },
    ]);
    assert.equal(h.state().calls.length, 1);
    assert.equal(h.state().calls[0].status, "completed");
    assert.deepEqual(h.state().calls[0].rawInput, { path: "native.txt" });
    assert.equal(h.state().calls[0].rawOutput, "Native result");
    assert.equal(h.state().binding.bad, false);
    const display = h.events.filter(
      (e) => e.type === ACP_MESSAGE || e.type === ACP_EVENT,
    );
    const startText = display.findIndex(
      (e) => e.type === ACP_MESSAGE && e.data.delta === "Starting. ",
    );
    const nativeCall = display.findIndex((e) => e.type === ACP_EVENT);
    const finalText = display.findIndex(
      (e) => e.type === ACP_MESSAGE && e.data.delta === "Done.",
    );
    assert(
      startText >= 0 && nativeCall > startText && finalText > nativeCall,
      "text and calls retain ACP arrival order",
    );
    assert.notEqual(display[startText].data.id, display[finalText].data.id);
  } finally {
    h.adapter.dispose();
  }
});

test("native prompt token accounting feeds DSH throughput with disjoint cache buckets", async () => {
  const h = harness("token-usage");
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    const usage = chunks.filter((c) => c.type === "usage");
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].usage, {
      inputTokens: 2195,
      outputTokens: 63,
      totalTokens: 8905,
      cacheReadTokens: 6647,
      cacheWriteTokens: 0,
      reasoningTokens: 12,
    });
    const assembler = new BlockAssembler();
    chunks.forEach((c) => assembler.push(c));
    assert.deepEqual(assembler.usage, usage[0].usage);
    assert.equal(chunks.at(-1).reason.kind, "stop");
  } finally {
    h.adapter.dispose();
  }
});

test("missing or invalid response counters never become invented token counts", () => {
  const valid = {
    inputTokens: 100,
    outputTokens: 30,
    cachedReadTokens: 20,
    cachedWriteTokens: 10,
    thoughtTokens: 12,
    totalTokens: 160,
  };
  for (const value of [
    undefined,
    null,
    { used: 1000, size: 1048576 },
    { ...valid, outputTokens: -1 },
    { ...valid, totalTokens: 140 },
    { ...valid, cachedReadTokens: NaN },
    { ...valid, thoughtTokens: 31 },
  ])
    assert.equal(acpTokenUsage(value), undefined);
  assert.deepEqual(acpTokenUsage(valid), {
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    reasoningTokens: 12,
    totalTokens: 160,
  });
  assert.deepEqual(acpTokenUsage({ inputTokens: 100, outputTokens: 0 }), {
    inputTokens: 100,
    outputTokens: 0,
  });
});
test("only explicitly selected extension tools execute through MCP, once, with scoped DSH policy", async () => {
  const h = harness("normal", ["weather"]);
  try {
    await collect(h.adapter.stream(h.options));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].calls[0].name, "weather");
    assert.equal(h.calls[0].calls[0].arguments, '{"query":"hello"}');
    assert.equal(h.calls[0].agent, h.agent);
    assert(h.calls[0].toolSet);
    assert.equal(h.disposed(), 1);
    assert.equal(
      h.state().calls.length,
      2,
      "ACP is the sole tool-row producer; no duplicate MCP row",
    );
    assert.equal(h.state().calls[1].origin, "DSH · MCP");
  } finally {
    h.adapter.dispose();
  }
});
test("native permission requests use DSH approval and preserve their waiting status", async () => {
  const h = harness("permission");
  let requested;
  h.ctx.get = (name) =>
    name === "approval"
      ? {
          request: async (req) => {
            requested = req;
            return "allowed-once";
          },
        }
      : undefined;
  try {
    await collect(h.adapter.stream(h.options));
    assert.equal(requested.agent, h.agent);
    assert.match(requested.reason, /native.txt/);
    assert(
      h.events.some(
        (e) => e.type === ACP_EVENT && e.data.status === "waiting_approval",
      ),
    );
    assert.equal(h.state().calls[0].status, "completed");
  } finally {
    h.adapter.dispose();
  }
});
test("missing approval fails closed", async () => {
  const h = harness("permission");
  try {
    await collect(h.adapter.stream(h.options));
    assert.equal(h.state().calls[0].status, "failed");
    assert.equal(h.state().calls[0].permission.outcome, "unavailable");
  } finally {
    h.adapter.dispose();
  }
});
test("an existing full-access session grant selects ACP allow_once without requesting escalation", async () => {
  const h = harness("permission");
  let approvalRequests = 0;
  h.ctx.get = (name) =>
    name === "permissionPresets"
      ? {
          current: (session) => {
            assert.equal(session, h.agent.session);
            return "danger-full-access";
          },
          resolve: () => ({ sandbox: "danger-full-access", approval: "never" }),
        }
      : name === "approval"
        ? {
            request: async () => {
              approvalRequests++;
              return "rejected";
            },
          }
        : undefined;
  try {
    await collect(h.adapter.stream(h.options));
    assert.equal(approvalRequests, 0);
    const call = h.state().calls[0];
    assert.equal(call.status, "completed");
    assert.equal(call.permission.outcome, "allowed-once");
    assert.equal(call.permission.source, "session-preset");
    assert.equal(call.permission.preset, "danger-full-access");
  } finally {
    h.adapter.dispose();
  }
});
test("restricted, Auto, custom, and misconfigured presets still require approval", async () => {
  for (const [preset, sandbox, approval] of [
    ["workspace-write", "workspace-write", "never"],
    ["auto", "danger-full-access", "never"],
    ["custom", "danger-full-access", "never"],
    ["danger-full-access", "workspace-write", "never"],
    ["danger-full-access", "danger-full-access", "ask"],
  ]) {
    const h = harness("permission");
    let requests = 0;
    h.ctx.get = (name) =>
      name === "permissionPresets"
        ? {
            current: () => preset,
            resolve: () => ({ sandbox, approval }),
          }
        : name === "approval"
          ? {
              request: async () => {
                requests++;
                return "rejected";
              },
            }
          : undefined;
    try {
      await collect(h.adapter.stream(h.options));
      assert.equal(requests, 1, preset);
      assert.equal(h.state().calls[0].status, "failed", preset);
      assert.equal(h.state().calls[0].permission.outcome, "rejected", preset);
    } finally {
      h.adapter.dispose();
    }
  }
});
test("full access never invents a persistent allow grant when allow_once is absent", async () => {
  const h = harness("permission-always");
  h.ctx.get = (name) =>
    name === "permissionPresets"
      ? {
          current: () => "danger-full-access",
          resolve: () => ({ sandbox: "danger-full-access", approval: "never" }),
        }
      : undefined;
  try {
    await collect(h.adapter.stream(h.options));
    assert.equal(h.state().calls[0].status, "failed");
    assert.equal(h.state().calls[0].permission.outcome, "unavailable");
  } finally {
    h.adapter.dispose();
  }
});
test("a rejected native command with no final reply reports the permission failure instead of success", async () => {
  const h = harness("permission-empty");
  h.ctx.get = (name) =>
    name === "approval" ? { request: async () => "rejected" } : undefined;
  try {
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      (error) => error.code === "ACP_PERMISSION_DENIED",
    );
    assert.equal(h.state().calls[0].permission.outcome, "rejected");
    assert.equal(
      h.state().binding.bad,
      false,
      "the native reply settled; never replay the failed task automatically",
    );
  } finally {
    h.adapter.dispose();
  }
});
test("an empty native final reply is not reported as a successful answer", async () => {
  const h = harness("empty-reply");
  try {
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      (error) => error.code === "ACP_EMPTY_REPLY",
    );
    assert.equal(h.state().binding.bad, false);
  } finally {
    h.adapter.dispose();
  }
});
test("native choice questions return the exact human-selected option rather than an arbitrary allow_once", async () => {
  const h = harness("question");
  h.ctx.get = (name) =>
    name === "userQuestions"
      ? {
          ask: async (request) => {
            assert.equal(request.questions[0].id, "interaction_color");
            return {
              answers: [{ id: "interaction_color", selected: ["2. Blue"] }],
            };
          },
        }
      : undefined;
  try {
    await collect(h.adapter.stream(h.options));
    assert.equal(
      h.state().calls.find((c) => c.id === "native-read").status,
      "completed",
    );
  } finally {
    h.adapter.dispose();
  }
});
test("background tools and model output can settle after ACP end_turn", async () => {
  const h = harness("background-after-end-turn");
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join(""), "Still running. Done.");
    assert.equal(h.state().calls.find((call) => call.id === "background").status, "completed");
  } finally {
    h.adapter.dispose();
  }
});
test("an unconfirmed foreground deadline fails without clearing the uncertain binding", async () => {
  const h = harness("background-after-end-turn-timeout");
  h.adapter.config.requestTimeoutMs = 220;
  try {
    await assert.rejects(() => collect(h.adapter.stream(h.options)), { code: "ACP_SETTLE_TIMEOUT" });
    assert.equal(h.state().calls.find((call) => call.id === "background").status, "incomplete");
    assert.equal(h.state().binding.bad, true);
    assert.equal(h.adapter.connections.size, 0);
  } finally {
    h.adapter.dispose();
  }
});

test("late pending edits and intermediate usage do not close the foreground before the final reply", async () => {
  const h = harness("late-after-end-turn", [], "auto", { normal: 100, continued: 175 });
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    h.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join(""),
      "Early reply. Interim reply. Final reply.");
    const edit = h.state().calls.find((call) => call.id === "late-edit");
    assert.equal(edit.status, "completed");
    assert.equal(edit.survivesHostTurn, undefined);
    assert.equal(h.state().binding.bad, false);
    assert.equal(h.events.at(-3).type, ACP_MESSAGE);
    assert.equal(h.events.at(-3).data.end, "settled");
  } finally {
    h.adapter.dispose();
  }
});

for (const [scenario, expected] of [["steering-during-settlement", "stop"], ["steering-stop", "max-tokens"]]) {
  test(`${scenario} keeps accepting steering until the foreground settles`, async () => {
    const h = harness(scenario, [], "auto", { normal: 100, continued: 175 });
    let inserted;
    h.agent.inbox = { nextStep: [] };
    h.ctx.on = (event, listener) => {
      if (event !== "agent/inbox/inserted") return () => {};
      inserted = listener;
      return () => { inserted = undefined; };
    };
    try {
      const stream = h.adapter.stream(h.options);
      assert.equal((await stream.next()).value.type, "block-start");
      assert.equal((await stream.next()).value.text, "Initial reply.");
      await new Promise((resolve) => setTimeout(resolve, 25));
      for (const text of ["first steering", "second steering"]) {
        const message = { id: text, role: "user", content: [{ type: "text", text }] };
        h.agent.inbox.nextStep.push(message);
        inserted?.({ agent: h.agent, message });
      }
      const chunks = await collect(stream);
      assert.equal(chunks.at(-1).reason.kind, expected);
      if (expected === "stop") assert.ok(chunks.some((chunk) => chunk.text === "Both updates handled."));
      assert.equal(h.state().binding.steered.length, 2);
      assert.equal(inserted, undefined);
    } finally {
      h.adapter.dispose();
    }
  });
}

test("a late native question without a tool ID keeps the turn open until answered", async () => {
  const h = harness("late-after-end-turn-question", [], "auto", { normal: 100, continued: 175 });
  h.ctx.get = (name) => name === "userQuestions" ? {
    ask: async () => {
      await new Promise((resolve) => setTimeout(resolve, 210));
      return { answers: [{ id: "q", custom: "Confirmed" }] };
    },
  } : undefined;
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    assert.equal(chunks.at(-1).reason.kind, "stop");
    assert.ok(chunks.some((chunk) => chunk.text?.includes("Confirmed")));
    assert.equal(h.state().binding.bad, false);
  } finally {
    h.adapter.dispose();
  }
});

test("a shorter ACP deadline still permits a quiet successful turn", async () => {
  const h = harness("normal", [], "auto", { normal: 400, continued: 500 });
  h.adapter.config.requestTimeoutMs = 220;
  try {
    assert.equal((await collect(h.adapter.stream(h.options))).at(-1).reason.kind, "stop");
  } finally {
    h.adapter.dispose();
  }
});

test("a declared daemon can keep running after the foreground finishes", async () => {
  const h = harness("late-after-end-turn-daemon");
  try {
    assert.equal((await collect(h.adapter.stream(h.options))).at(-1).reason.kind, "stop");
    const daemon = h.state().calls.find((call) => call.id === "daemon");
    assert.equal(daemon.status, "in_progress");
    assert.equal(daemon.survivesHostTurn, true);
    assert.equal(h.adapter.connections.size, 1);
  } finally {
    h.adapter.dispose();
  }
});

test("cancelling after end_turn closes the connection without confirming uncertain native work", async () => {
  const h = harness("late-after-end-turn-cancel", [], "auto", { normal: 200, continued: 250 });
  const abort = new AbortController();
  try {
    const stream = h.adapter.stream({ ...h.options, signal: abort.signal });
    await stream.next();
    assert.equal((await stream.next()).value.text, "Early reply. ");
    await new Promise((resolve) => setTimeout(resolve, 25));
    abort.abort();
    assert.equal((await collect(stream)).at(-1).reason.kind, "aborted");
    assert.equal(h.state().binding.bad, true);
    assert.equal(h.adapter.connections.size, 0);
  } finally {
    h.adapter.dispose();
  }
});

test("transport exit during settlement fails the turn and preserves the uncertain binding", async () => {
  const h = harness("late-after-end-turn-close", [], "auto", { normal: 200, continued: 250 });
  try {
    await assert.rejects(() => collect(h.adapter.stream(h.options)), /exited \(23\)/);
    assert.equal(h.state().binding.bad, true);
    assert.equal(h.adapter.connections.size, 0);
  } finally {
    h.adapter.dispose();
  }
});

test("a completed monitor can wake an idle session on the retained transport and use the existing grant", async () => {
  const h = harness("idle-wake");
  h.ctx.get = (name) => name === "permissionPresets" ? {
    current: () => "danger-full-access",
    resolve: () => ({ sandbox: "danger-full-access", approval: "never" }),
  } : undefined;
  const first = await collect(h.adapter.stream(h.options));
  assert.ok(first.some((item) => item.type === "text-delta" && item.text === "Monitor registered."));
  h.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  try {
    const settled = new Promise((resolve, reject) => {
      const append = h.agent.session.append;
      const timer = setTimeout(() => reject(new Error("The monitor did not wake")), 2000);
      h.agent.session.append = (type, data) => {
        const record = append.call(h.agent.session, type, data);
        if (type === ACP_MESSAGE && data.end === "settled") {
          clearTimeout(timer);
          resolve(record);
        }
        return record;
      };
    });
    await settled;
    assert.ok(h.events.some((event) => event.type === ACP_MESSAGE && event.data.delta === "Monitor woke."));
    const resumedTool = h.state().calls.find((call) => call.id === "wake-read");
    assert.equal(resumedTool.status, "completed");
    assert.equal(resumedTool.permission.outcome, "allowed-once");
    assert.equal(h.state().runningTurn, null);
    const next = { id: "next-task", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "next task" }] };
    const chunks = await collect(h.adapter.stream({ ...h.options, messages: [...h.options.messages, next] }));
    assert.ok(chunks.some((item) => item.type === "text-delta" && item.text === "Same transport."));
  } finally {
    h.adapter.dispose();
  }
});
test("ACP forms return multiple option IDs alongside custom text and handle cancellation", async () => {
  for (const cancelled of [false, true]) {
    const h = harness("elicitation");
    h.ctx.get = (name) => name === "userQuestions" ? {
      ask: async ({ questions }) => {
        assert.equal(questions.length, 1);
        assert.equal(questions[0].multiSelect, true);
        if (cancelled) throw Object.assign(new Error("Cancelled"), { code: "ASK_CANCELLED" });
        return { answers: [{ id: "q1", selected: ["Cheese", "Olives"], custom: "Basil" }] };
      },
    } : undefined;
    try {
      const chunks = await collect(h.adapter.stream(h.options));
      const response = chunks.filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => chunk.text).join("");
      assert.deepEqual(JSON.parse(response), cancelled
        ? { action: "cancel" }
        : { action: "accept", content: { q1: ["1", "2"], q1_other: "Basil" } });
    } finally {
      h.adapter.dispose();
    }
  }
});
test("official account suspension text is a non-retryable account error, not successful work", async () => {
  const h = harness("disabled");
  try {
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      (e) => e.code === "ACCOUNT_DISABLED",
    );
    assert.equal(h.calls.length, 0);
  } finally {
    h.adapter.dispose();
  }
});
test("DSH cancellation reaches session/cancel and the native session remains resumable", async () => {
  const h = harness("hang");
  const abort = new AbortController();
  const original = h.agent.session.append;
  h.agent.session.append = (type, data) => {
    const event = original(type, data);
    if (type === ACP_BINDING && data?.bad) setTimeout(() => abort.abort(), 25);
    return event;
  };
  try {
    const chunks = await collect(
      h.adapter.stream({ ...h.options, signal: abort.signal }),
    );
    assert.equal(chunks.at(-1).reason.kind, "aborted");
    assert.equal(h.state().binding.bad, false);
  } finally {
    h.adapter.dispose();
  }
});
for (const scenario of ["crash", "malformed"])
  test(`${scenario} fails without retries and blocks uncertain task replay`, async () => {
    const h = harness(scenario);
    try {
      await assert.rejects(() => collect(h.adapter.stream(h.options)));
      assert.equal(h.state().binding.bad, true);
      assert.equal(h.adapter.providerRetryPolicy().maxRetries, 0);
      await assert.rejects(
        () => collect(h.adapter.stream(h.options)),
        /uncertain outcome/,
      );
    } finally {
      h.adapter.dispose();
    }
  });
test("resumed sessions only receive new context; edited histories and forks fail explicitly", async () => {
  const h = harness();
  try {
    await collect(h.adapter.stream(h.options));
    const newMessages = [
      ...h.options.messages,
      {
        id: "assistant-1",
        role: "assistant",
        source: { provider: ACP_PROVIDER },
        content: [{ type: "text", text: "Done" }],
      },
      {
        id: "user-2",
        role: "user",
        content: [{ type: "text", text: "Continue" }],
      },
    ];
    assert.deepEqual(
      messagesAfterAnchor(newMessages, "user-1").map((m) => m.id),
      ["user-2"],
    );
    await collect(h.adapter.stream({ ...h.options, messages: newMessages }));
    assert.equal(h.state().binding.anchor, "user-2");
    await assert.rejects(
      () =>
        collect(
          h.adapter.stream({ ...h.options, messages: [newMessages.at(-1)] }),
        ),
      /No new messages|history was edited/,
    );
    assert.throws(
      () => messagesAfterAnchor([], "missing"),
      /no longer matches/,
    );
    h.agent.session.append(ACP_BINDING, {
      ...h.state().binding,
      owner: "parent-session",
    });
    await assert.rejects(() => collect(h.adapter.stream(h.options)), /fork/);
  } finally {
    h.adapter.dispose();
  }
});
test("catalog uses official advertised models and honest client identity", async () => {
  const h = harness();
  try {
    const models = await modelCatalog(h);
    assert.deepEqual(
      models.map((m) => m.id),
      ["default", "gemini-test"],
    );
  } finally {
    h.adapter.dispose();
  }
});
test("model catalog groups variants and exposes sorted native reasoning levels", async () => {
  const h = harness("model-selection");
  try {
    const models = await modelCatalog(h);
    assert.deepEqual(
      models.map((m) => [m.id, m.name]),
      [
        ["default", "Antigravity · 账号默认模型"],
        ["gemini-test", "Gemini Test"],
      ],
    );
    const model = await h.adapter.resolveModel(ACP_PROVIDER, "gemini-test");
    assert.deepEqual(
      model.reasoning.efforts.map((e) => e.id),
      ["low", "medium", "high"],
    );
    assert.equal(model.reasoning.defaultEffort, "medium");
    const legacy = await h.adapter.resolveModel(
      ACP_PROVIDER,
      "gemini-test-high",
    );
    assert.equal(legacy.reasoning.defaultEffort, "high");
  } finally {
    h.adapter.dispose();
  }
});
test("catalog requests observe login changes immediately, without retaining the previous account catalog", async () => {
  const h = harness("model-selection");
  try {
    assert.equal((await modelCatalog(h)).length, 2);
    h.adapter.config.args = [fixture, "empty-models"];
    assert.deepEqual(
      (await modelCatalog(h)).map((m) => m.id),
      ["default"],
    );
  } finally {
    h.adapter.dispose();
  }
});
test("failed or missing official catalogs clear the previous account models", async () => {
  for (const scenario of ["catalog-failure", "no-models"]) {
    const h = harness("model-selection");
    try {
      await modelCatalog(h);
      h.adapter.config.args = [fixture, scenario];
      assert.deepEqual(
        (await modelCatalog(h)).map((m) => m.id),
        ["default"],
      );
    } finally {
      h.adapter.dispose();
    }
  }
});
test("concurrent catalog requests share discovery and unchanged models do not trigger refresh loops", async () => {
  const h = harness("model-selection");
  let discoveries = 0;
  const updates = [];
  const discover = h.adapter.discover.bind(h.adapter);
  h.adapter.discover = async (revision) => {
    discoveries++;
    await discover(revision);
  };
  h.ctx.emit = (...args) => updates.push(args);
  try {
    const [first, second] = await Promise.all([
      h.adapter.listModels(ACP_PROVIDER),
      h.adapter.listModels(ACP_PROVIDER),
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((m) => m.id),
      ["default"],
    );
    while (h.adapter.catalogTask) await h.adapter.catalogTask;
    assert.equal(discoveries, 1);
    await modelCatalog(h);
    assert.equal(
      discoveries,
      1,
      "model update notifications do not launch another ACP process",
    );
    h.adapter.catalogRefreshAfter = 0;
    await modelCatalog(h);
    assert.equal(discoveries, 2);
    assert.deepEqual(updates, [["llm/models-updated", ACP_PROVIDER]]);
  } finally {
    h.adapter.dispose();
  }
});
test("cold and cached model enumeration and resolution finish while ACP discovery is blocked", async () => {
  for (const cached of [false, true]) {
    const h = harness();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    if (cached)
      h.adapter.updateCatalog({
        models: {
          availableModels: [{ modelId: "cached-high", name: "Cached (High)" }],
        },
      });
    h.adapter.catalogRefreshAfter = 0;
    h.adapter.discover = async () => {
      started();
      await gate;
    };
    let timeout;
    try {
      const result = await Promise.race([
        Promise.all([
          h.adapter.listModels(ACP_PROVIDER),
          h.adapter.resolveModel(ACP_PROVIDER, cached ? "cached" : "default"),
        ]),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("model enumeration waited for ACP")),
            500,
          );
        }),
      ]);
      await ready;
      assert.deepEqual(
        result[0].map((m) => m.id),
        cached ? ["default", "cached"] : ["default"],
      );
      assert.equal(result[1].id, cached ? "cached" : "default");
    } finally {
      clearTimeout(timeout);
      release();
      await h.adapter.catalogTask;
      h.adapter.dispose();
    }
  }
});
test("credential metadata changes invalidate the old snapshot and refresh in the background within the cooldown", async () => {
  const h = harness("model-selection");
  let version = "login-one";
  h.adapter.credentialVersion = async () => version;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  try {
    await modelCatalog(h);
    while (h.adapter.catalogTask) await h.adapter.catalogTask;
    const discover = h.adapter.discover.bind(h.adapter);
    h.adapter.discover = async (revision) => {
      started();
      await gate;
      await discover(revision);
    };
    version = "login-two";
    await h.adapter.listModels(ACP_PROVIDER);
    await ready;
    assert.deepEqual(
      (await h.adapter.listModels(ACP_PROVIDER)).map((m) => m.id),
      ["default"],
    );
    release();
    while (h.adapter.catalogTask) await h.adapter.catalogTask;
    assert.equal((await h.adapter.listModels(ACP_PROVIDER)).length, 2);
  } finally {
    release();
    h.adapter.dispose();
  }
});
test("a late background catalog cannot overwrite a newer interactive session catalog", async () => {
  const h = harness("slow-catalog");
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const connect = h.adapter.connection.bind(h.adapter);
  h.adapter.connection = (cwd) => {
    const rpc = connect(cwd);
    rpc.onNotification = (method) => {
      if (method === "test/catalog-waiting") started();
    };
    return rpc;
  };
  try {
    await h.adapter.listModels(ACP_PROVIDER);
    await ready;
    h.adapter.updateCatalog({
      models: {
        availableModels: [{ modelId: "fresh-high", name: "Fresh (High)" }],
      },
    });
    while (h.adapter.catalogTask) await h.adapter.catalogTask;
    assert.deepEqual(
      (await h.adapter.listModels(ACP_PROVIDER)).map((m) => m.id),
      ["default", "fresh"],
    );
  } finally {
    h.adapter.dispose();
  }
});
test("disposing during a hung background handshake closes its process and never publishes stale updates", async () => {
  const h = harness("catalog-hang");
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const updates = [];
  h.ctx.emit = (...args) => updates.push(args);
  const connect = h.adapter.connection.bind(h.adapter);
  h.adapter.connection = (cwd) => {
    const rpc = connect(cwd);
    rpc.onNotification = (method) => {
      if (method === "test/catalog-waiting") started();
    };
    return rpc;
  };
  try {
    assert.deepEqual(
      (await h.adapter.listModels(ACP_PROVIDER)).map((m) => m.id),
      ["default"],
    );
    await ready;
    h.adapter.dispose();
    await h.adapter.catalogTask;
    assert.equal(h.adapter.connections.size, 0);
    assert.deepEqual(updates, []);
  } finally {
    h.adapter.dispose();
  }
});
test("file credentials are selected in the official child only and store changes cannot resume an old session", async () => {
  const originalBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const h = harness("file-storage", [], "file");
  try {
    assert.equal((await modelCatalog(h)).length, 2);
    await collect(h.adapter.stream(h.options));
    assert.equal(h.state().binding.credentialStore, "file");
    assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, originalBus);
    h.adapter.config.credentialStore = "auto";
    await assert.rejects(
      () =>
        collect(
          h.adapter.stream({
            ...h.options,
            messages: [
              ...h.options.messages,
              {
                id: "next",
                role: "user",
                content: [{ type: "text", text: "Next task" }],
              },
            ],
          }),
        ),
      (e) => e.code === "ACP_AUTH_CONTEXT",
    );
  } finally {
    h.adapter.dispose();
  }
});
test("grouped model and reasoning selection send an exact advertised native variant", async () => {
  const h = harness("model-selection");
  try {
    const chunks = await collect(
      h.adapter.stream({
        ...h.options,
        model: "gemini-test",
        reasoningEffort: "low",
      }),
    );
    assert.equal(
      chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => c.text)
        .join(""),
      "gemini-test-low",
    );
  } finally {
    h.adapter.dispose();
  }
});
test("unavailable thinking levels are rejected without inventing a native variant", async () => {
  const h = harness("model-selection");
  try {
    await assert.rejects(
      () =>
        collect(
          h.adapter.stream({
            ...h.options,
            model: "gemini-test",
            reasoningEffort: "max",
          }),
        ),
      (e) => e.code === "ACP_CONTROLS",
    );
    assert.equal(h.state().binding, null);
  } finally {
    h.adapter.dispose();
  }
});
test("an explicitly empty native catalog removes old entries instead of retaining stale account models", async () => {
  const h = harness("model-selection");
  try {
    assert.equal((await modelCatalog(h)).length, 2);
    h.adapter.config.args = [fixture, "empty-models"];
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      (e) => e.code === "ACP_MODEL",
    );
    assert.deepEqual(
      (await modelCatalog(h)).map((m) => m.id),
      ["default"],
    );
  } finally {
    h.adapter.dispose();
  }
});
test("grouping keeps families separate and never infers account access or unknown model suffixes", () => {
  const session = {
    models: {
      currentModelId: "argon-high",
      availableModels: [
        { modelId: "argon-medium", name: "Argon (Medium)" },
        { modelId: "argon-high", name: "Argon (High)" },
        { modelId: "hydrogen-high", name: "Hydrogen (High)" },
        { modelId: "hydrogen-xhigh", name: "Hydrogen (XHigh)" },
        { modelId: "named-high", name: "A distinct model named High" },
        { modelId: "custom-adaptive", name: "Custom (Adaptive)" },
      ],
    },
  };
  const groups = groupAcpModels(session);
  assert.deepEqual(
    groups.map((g) => g.id),
    ["argon", "hydrogen", "named-high", "custom-adaptive"],
  );
  assert.equal(resolveAcpModelSelection(session, "argon"), "argon-high");
  assert.equal(
    resolveAcpModelSelection(session, "hydrogen", "xhigh"),
    "hydrogen-xhigh",
  );
  assert.equal(
    resolveAcpModelSelection(session, "argon-medium"),
    "argon-medium",
  );
  assert.throws(
    () => resolveAcpModelSelection(session, "not-advertised"),
    (e) => e.code === "ACP_MODEL",
  );
  assert.throws(
    () => resolveAcpModelSelection(session, "hydrogen", "low"),
    (e) => e.code === "ACP_CONTROLS",
  );
});
test("config-option model ids disambiguate variants even when display labels omit the effort", () => {
  const session = {
    models: {
      availableModels: [
        { modelId: "model-low", name: "Model" },
        { modelId: "model-high", name: "Model" },
      ],
    },
    configOptions: [
      {
        id: "model",
        currentValue: "model",
        options: [{ value: "model", name: "Model" }],
      },
      { id: "thought_level", currentValue: "high" },
    ],
  };
  assert.deepEqual(
    groupAcpModels(session).map((g) => g.id),
    ["model"],
  );
  assert.equal(resolveAcpModelSelection(session, "model"), "model-high");
});
test("explicit DSH skill invocations send the file path and arguments to ACP", async () => {
  const h = harness("echo-prompt");
  const directory = await mkdtemp(join(tmpdir(), "dsh-acp-skill-"));
  const path = join(directory, "SKILL.md");
  await writeFile(path, "Private skill body");
  h.ctx.get = (name) => name === "skills" ? {
    get: async () => ({
      invocation: { userInvocable: true },
      resourceBase: { kind: "directory", path: directory },
    }),
  } : undefined;
  const user = { id: "skill-task", role: "user", source: { kind: "user" },
    content: [{ type: "text", text: "/example argument" }] };
  const invocation = { id: "injected-skill", role: "user",
    source: { kind: "skill-invocation", name: "example" },
    content: [{ type: "text", text: "Private skill body" }] };
  try {
    const chunks = await collect(h.adapter.stream({ ...h.options, messages: [user, invocation] }));
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    const [block] = JSON.parse(text);
    assert.ok(block.text.includes(JSON.stringify(path)));
    assert.ok(block.text.endsWith("/example argument"));
    assert.ok(!block.text.includes("Private skill body"));
    assert.equal(h.state().binding.anchor, user.id);
  } finally {
    h.adapter.dispose();
  }
});
test("fresh ACP sessions receive only the current user task, without system append or generated harness context", async () => {
  const h = harness("echo-prompt");
  const marker = "AUTOMATIC_CONTEXT_DSH_PI_CODEX_CLAUDECODE";
  const injected = (id, role, kind) => ({
    id,
    role,
    source: { kind },
    content: [{ type: "text", text: marker.repeat(20) }],
  });
  const messages = [
    injected("system", "system", "system-prompt"),
    injected("dev", "developer", "tool-registry"),
    {
      id: "old-user",
      role: "user",
      source: { kind: "user" },
      content: [
        { type: "text", text: "An old task that must not be replayed" },
      ],
    },
    injected("runtime", "user", "runtime-context"),
    injected("workspace", "user", "workspace-instructions"),
    injected("assistant", "assistant", "model"),
    injected("result", "tool", "tool"),
    {
      id: "current",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Read the requested file." }],
    },
  ];
  try {
    const chunks = await collect(
      h.adapter.stream({ ...h.options, system: marker, messages }),
    );
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    assert.deepEqual(JSON.parse(text), [
      { type: "text", text: "Read the requested file." },
    ]);
  } finally {
    h.adapter.dispose();
  }
});
test("resumed ACP prompts omit automatic messages and preserve genuine user text verbatim", async () => {
  const h = harness("echo-prompt");
  try {
    await collect(h.adapter.stream(h.options));
    const task =
      "Please review DSH, pi, codex and claudecode integration code.";
    const messages = [
      ...h.options.messages,
      {
        id: "notice",
        role: "user",
        source: { kind: "runtime-context" },
        content: [
          { type: "text", text: "Automatically generated DSH instructions" },
        ],
      },
      {
        id: "other-model",
        role: "assistant",
        source: { provider: "other", kind: "model" },
        content: [{ type: "text", text: "Previous harness boilerplate" }],
      },
      {
        id: "user-2",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: task }],
      },
    ];
    const chunks = await collect(h.adapter.stream({ ...h.options, messages }));
    assert.deepEqual(
      JSON.parse(
        chunks
          .filter((c) => c.type === "text-delta")
          .map((c) => c.text)
          .join(""),
      ),
      [{ type: "text", text: task }],
    );
  } finally {
    h.adapter.dispose();
  }
});
test("sessions with older injected context require an explicit native-context reset", async () => {
  const h = harness();
  try {
    await collect(h.adapter.stream(h.options));
    const { promptPolicy, ...oldBinding } = h.state().binding;
    h.agent.session.append(ACP_BINDING, oldBinding);
    await assert.rejects(
      () =>
        collect(
          h.adapter.stream({
            ...h.options,
            messages: [
              ...h.options.messages,
              {
                id: "next",
                role: "user",
                content: [{ type: "text", text: "Next task" }],
              },
            ],
          }),
        ),
      (e) => e.code === "ACP_CONTEXT_POLICY",
    );
    h.agent.session.append(ACP_BINDING, { reset: true });
    assert.equal(h.state().binding, null);
  } finally {
    h.adapter.dispose();
  }
});
test("MCP results do not append automatically generated tool contexts", async () => {
  const h = harness("normal", ["weather"]);
  h.ctx.tools.execute = async () => ({
    results: [
      {
        result: { isError: false, content: [{ type: "text", text: "Sunny" }] },
      },
    ],
    additionalContexts: [
      {
        role: "user",
        content: [{ type: "text", text: "Automatic DSH runtime guidance" }],
      },
    ],
  });
  try {
    await collect(h.adapter.stream(h.options));
    const output = h.state().calls.find((c) => c.id === "native-mcp").rawOutput;
    assert.deepEqual(output.content, [{ type: "text", text: "Sunny" }]);
  } finally {
    h.adapter.dispose();
  }
});
test("tools are empty by default and common native duplicates or unavailable extensions are rejected", () => {
  assert.deepEqual(selectMcpTools([], []), []);
  for (const name of ["bash", "read_file", "apply_patch", "subagent", "grep"])
    assert.throws(() => selectMcpTools([{ name }], [name]), /overlaps/);
  assert.throws(() => selectMcpTools([], ["missing"]), /unavailable/);
  assert.throws(() => selectMcpTools([], ["weather", "weather"]), /Duplicate/);
});
test("concurrent MCP requests cannot overlap exclusive DSH batches", async () => {
  let active = 0,
    maximum = 0;
  const bridge = new DshMcpBridge(
    [
      {
        name: "weather",
        mcpName: "dsh_weather",
        description: "Weather",
        parameters: { type: "object" },
      },
    ],
    async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { content: [{ type: "text", text: "Sunny" }] };
    },
  );
  await bridge.start();
  try {
    const env = Object.fromEntries(
      bridge.descriptor().env.map((e) => [e.name, e.value]),
    );
    const responses = await Promise.all(
      [1, 2].map(async (id) => {
        const response = await fetch(env.GOOGLE_ACP_MCP_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.GOOGLE_ACP_MCP_TOKEN}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "dsh_weather", arguments: {} },
          }),
        });
        return response.json();
      }),
    );
    assert.equal(maximum, 1);
    assert(responses.every((r) => r.result.content[0].text === "Sunny"));
  } finally {
    await bridge.close();
  }
});
test("edited content with an unchanged message id cannot silently resume a stale ACP conversation", async () => {
  const h = harness();
  try {
    await collect(h.adapter.stream(h.options));
    const changed = [
      {
        ...h.options.messages[0],
        content: [{ type: "text", text: "Edited earlier prompt" }],
      },
      { id: "u2", role: "user", content: [{ type: "text", text: "Continue" }] },
    ];
    await assert.rejects(
      () => collect(h.adapter.stream({ ...h.options, messages: changed })),
      (e) => e.code === "ACP_HISTORY",
    );
  } finally {
    h.adapter.dispose();
  }
});
test("native turn timeout stops the process and does not replay uncertain work", async () => {
  const h = harness("hang");
  h.adapter.config.requestTimeoutMs = 40;
  try {
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      /timed out/,
    );
    assert.equal(h.state().binding.bad, true);
  } finally {
    h.adapter.dispose();
  }
});
test("partial tool updates retain input, ids are native-session scoped, and history replays exactly", () => {
  let state = acpProjection.init();
  const events = [];
  const session = {
    append(type, data) {
      events.push({ type, data: structuredClone(data), time: Date.now() });
    },
  };
  const write = (type, data) => session.append(type, data);
  const recorder = new NativeToolRecorder(session, "native-a", 1, write);
  recorder.update({
    toolCallId: "one",
    title: "read",
    rawInput: { path: "a" },
    status: "in_progress",
  });
  recorder.update({ toolCallId: "one", rawOutput: "a", status: "completed" });
  const other = new NativeToolRecorder(session, "native-b", 2, write);
  other.update({ toolCallId: "one", title: "second", status: "in_progress" });
  events.push({
    type: "turn/end",
    data: { turn: 2, reason: { kind: "aborted" } },
    time: Date.now(),
  });
  for (const event of events) state = acpProjection.apply(state, event);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls[0].rawInput, { path: "a" });
  assert.equal(state.calls[1].status, "cancelled");
  assert.deepEqual(
    events.reduce(acpProjection.apply, acpProjection.init()),
    state,
  );
  assert.equal(acpProjection.apply(state, { type: "unrelated" }), state);
});
test("ACP records use the host's ignorable plugin envelopes and survive a real Session restore", () => {
  const session = Session.create("acp-persistence");
  const recorder = new NativeToolRecorder(session, "native", 1, (type, data) =>
    appendAcpRecord(session, type, data),
  );
  recorder.update({
    toolCallId: "one",
    title: "native read",
    status: "completed",
    rawOutput: "result",
  });
  appendAcpRecord(session, ACP_BINDING, {
    owner: session.id,
    nativeSessionId: "native",
    anchor: null,
    historyHash: "hash",
    promptPolicy: "native-user-input-v1",
    bad: false,
  });
  const records = JSON.parse(JSON.stringify(session.snapshotEvents()));
  assert(
    records.every(
      (e) => e.ignorable === true && e.type.startsWith("plugin:yu-google-acp/"),
    ),
  );
  const restored = Session.create("acp-restored", records);
  const state = restored
    .snapshotEvents()
    .reduce(acpProjection.apply, acpProjection.init());
  assert.equal(state.calls[0].rawOutput, "result");
  assert.equal(state.binding.nativeSessionId, "native");
  const legacy = records.map((e) => ({
    ...e,
    type: e.type.replace(/^plugin:/, ""),
  }));
  assert.deepEqual(
    legacy.reduce(acpProjection.apply, acpProjection.init()),
    state,
  );
});
test("large native output stays a valid bounded preview and retains its completed tool state", () => {
  const events = [];
  const recorder = new NativeToolRecorder(
    { append: (type, data) => events.push({ type, data }) },
    "native",
    1,
    (type, data) => events.push({ type, data }),
  );
  recorder.update({
    toolCallId: "large",
    title: "Large read",
    content: [
      { type: "content", content: { type: "text", text: "x".repeat(200000) } },
    ],
    rawOutput: "x".repeat(200000),
    status: "completed",
  });
  const state = acpProjection.apply(acpProjection.init(), events[0]);
  assert.equal(state.calls[0].status, "completed");
  assert.equal(state.calls[0].rawOutput.truncated, true);
  assert(Array.isArray(state.calls[0].content));
  assert.equal(state.calls[0].content[0].truncated, true);
});
test("unsupported images and headless runtime flags cannot silently change the subscription path", async () => {
  assert.throws(
    () => buildAcpPrompt([{ role: "user", content: [{ type: "image" }] }]),
    /text only/,
  );
  for (const args of [
    ["-p", "hello"],
    ["acp", "--dangerously-skip-permissions"],
    ["acp", "--cloud_code_endpoint=https://example.com"],
  ])
    await assert.rejects(() => apply({}, { args }), /official agy acp/);
});

test("plugin activation and reset use the profile Session writer independently of the launcher path", async () => {
  const commands = new Map();
  const session = Session.create("acp-profile-reset");
  const launcher = process.argv[1];
  try {
    process.argv[1] = join(await mkdtemp(join(tmpdir(), "acp-launcher-")), "bin.js");
    await apply({
      sessionProjections: { register: async () => ({}) },
      reflect: { provide() {} },
      llm: { registerAdapter() {} },
      on() {},
      inject(_services, ready) {
        ready({ commands: { register: (command) => commands.set(command.name, command) } });
      },
    }, { args: ["acp"] });
    const result = commands.get("google-acp-reset").handler({ agent: { id: session.id, session, status: "idle" } });
    assert.equal(result.kind, "success");
    assert.deepEqual(session.snapshotEvents().at(-1)?.data, { reset: true });
  } finally {
    process.argv[1] = launcher;
  }
});

test("startup and model-selection occupancy updates are retained without inventing billing usage", async () => {
  const h = harness("session-metadata");
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    assert.deepEqual(
      h.events
        .filter(
          (e) =>
            e.type === ACP_SESSION &&
            e.data.update.sessionUpdate === "usage_update",
        )
        .map((e) => e.data.update.used),
      [12000, 15000, 3000],
    );
    assert.deepEqual(h.state().native.usage, { used: 3000, size: 100000 });
    assert.equal(h.state().native.commands[0].name, "compact");
    assert(!chunks.some((c) => c.type === "usage"));
    assert.deepEqual(h.events.find((e) => e.type === "todo/write").data.todos, [
      { content: "Read sources", status: "completed" },
      { content: "Write result", status: "in_progress" },
    ]);
    const compact = h.state().calls.find((c) => c.id === "compaction:auto");
    assert.equal(compact.status, "completed");
    assert.equal(compact.rawOutput, "Part one. \nPart two.");
    assert(h.events.some((e) => e.type === "plugin:yu-google-acp/notice"));
    assert.deepEqual(
      h.events.reduce(acpProjection.apply, acpProjection.init()),
      h.state(),
    );
    h.agent.session.append(ACP_BINDING, { reset: true });
    assert.equal(h.state().native, null);
  } finally {
    h.adapter.dispose();
  }
});

test("native /compact resumes the exact agent session, updates its gauge, and preserves local history and anchor", async () => {
  const h = harness("session-compact");
  try {
    await collect(h.adapter.stream(h.options));
    const binding = structuredClone(h.state().binding);
    const result = await h.adapter.compact(
      h.agent,
      new AbortController().signal,
    );
    assert.equal(result.kind, "success");
    assert.deepEqual(h.state().binding, binding);
    assert.deepEqual(h.state().native.usage, { used: 1000, size: 100000 });
    assert(
      !h.events.some(
        (e) => e.type.startsWith("compaction/") || e.type === "user/message",
      ),
    );
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.state().calls.find((c) => c.id === "compaction:manual").rawOutput,
      "Native retained summary",
    );
    await collect(
      h.adapter.stream({
        ...h.options,
        messages: [
          ...h.options.messages,
          {
            id: "u2",
            role: "user",
            content: [{ type: "text", text: "Continue" }],
          },
        ],
      }),
    );
    assert.equal(h.state().binding.anchor, "u2");
  } finally {
    h.adapter.dispose();
  }
});

test("native compaction refuses missing capabilities, changed identity and concurrent maintenance", async () => {
  const h = harness("session-no-compact");
  try {
    const empty = await h.adapter.compact(
      h.agent,
      new AbortController().signal,
    );
    assert.equal(empty.kind, "success");
    await collect(h.adapter.stream(h.options));
    await assert.rejects(
      () => h.adapter.compact(h.agent, new AbortController().signal),
      /未提供/,
    );
    assert.equal(h.state().binding.bad, false);
    h.agent.status = "running";
    await assert.rejects(
      () => h.adapter.compact(h.agent, new AbortController().signal),
      /busy/,
    );
    h.agent.status = "idle";
    h.agent.session.append(ACP_BINDING, {
      ...h.state().binding,
      owner: "different-owner",
    });
    await assert.rejects(
      () => h.adapter.compact(h.agent, new AbortController().signal),
      /状态或认证配置已变化/,
    );
  } finally {
    h.adapter.dispose();
  }
});

test("uncertain native compaction cannot silently replay the session", async () => {
  const h = harness("session-compact-crash");
  try {
    await collect(h.adapter.stream(h.options));
    await assert.rejects(
      () => h.adapter.compact(h.agent, new AbortController().signal),
      /exited/,
    );
    assert.equal(h.state().binding.bad, true);
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      (e) => e.code === "ACP_RESUME",
    );
    assert.equal(h.adapter.active.size, 0);
  } finally {
    h.adapter.dispose();
  }
});

test("a native compaction failure is not reported as success when the prompt ends normally", async () => {
  const h = harness("session-compact-failed");
  try {
    await collect(h.adapter.stream(h.options));
    await assert.rejects(
      () => h.adapter.compact(h.agent, new AbortController().signal),
      /Native compaction refused/,
    );
    assert.equal(h.state().binding.bad, false);
    assert.equal(
      h.state().calls.find((c) => c.id === "compaction:manual").status,
      "failed",
    );
  } finally {
    h.adapter.dispose();
  }
});

test("compaction cancellation settles via the native cancel protocol and releases maintenance", async () => {
  const h = harness("session-compact-hang");
  try {
    await collect(h.adapter.stream(h.options));
    const operation = h.adapter.compact(h.agent, h.maintenanceAbort.signal);
    const timeout = setTimeout(
      () => h.maintenanceAbort.abort(new Error("cancel test")),
      120,
    );
    await assert.rejects(() => operation, /cancel test/);
    clearTimeout(timeout);
    assert.equal(h.state().binding.bad, false);
    assert.equal(h.adapter.active.size, 0);
    assert.equal(h.adapter.connections.size, 0);
  } finally {
    h.adapter.dispose();
  }
});

test("usage rejects malformed gauges and keeps only the latest value per native session", () => {
  const events = [];
  const updates = new NativeSessionUpdates((type, data) =>
    events.push({ type, data }),
  );
  const send = (id, used, size) =>
    updates.receive({
      sessionId: id,
      update: { sessionUpdate: "usage_update", used, size },
    });
  send("native", 0, 1000);
  send("other", 900, 1000);
  updates.bind("native");
  send("native", -1, 1000);
  send("native", 10, 0);
  send("native", 400, 1000);
  send("native", 50, 1000);
  assert.equal(events.length, 3);
  assert.equal(
    events.reduce(acpProjection.apply, acpProjection.init()).native.usage.used,
    50,
  );
});

test("web_reader is an explicit ordinary MCP tool with no host identity in its descriptor or schema", async () => {
  const selected = selectMcpTools(
    [
      {
        name: "web_reader",
        description: "Read a rendered page",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      },
    ],
    ["web_reader"],
  );
  assert.equal(selected[0].mcpName, "web_reader");
  const bridge = new DshMcpBridge(selected, async () => ({
    content: [{ type: "text", text: "Page content" }],
  }));
  await bridge.start();
  try {
    const descriptor = bridge.descriptor();
    assert(!/dsh|deepseek|harness/i.test(JSON.stringify(descriptor)));
    const env = Object.fromEntries(
      descriptor.env.map((e) => [e.name, e.value]),
    );
    const request = async (method) =>
      (
        await fetch(env.GOOGLE_ACP_MCP_ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${env.GOOGLE_ACP_MCP_TOKEN}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        })
      ).json();
    const tools = (await request("tools/list")).result.tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ["web_reader"],
    );
    assert(!/dsh|deepseek|harness/i.test(JSON.stringify(tools)));
    assert(
      !/dsh|deepseek|harness/i.test(
        JSON.stringify((await request("initialize")).result),
      ),
    );
  } finally {
    await bridge.close();
  }
});

test("admitted user images use ACP image blocks and automatically injected images stay excluded", async () => {
  const h = harness("echo-prompt");
  const attachment = {
    attachmentId: "test",
    mediaType: "image/png",
    bytes: 3,
    width: 1,
    height: 1,
  };
  const reads = [];
  h.ctx.get = (name) =>
    name === "attachments"
      ? {
          readImage: async (ref) => {
            reads.push(ref);
            return { ref, data: new Uint8Array([1, 2, 3]) };
          },
        }
      : undefined;
  h.options.messages = [
    {
      id: "automatic",
      role: "user",
      source: { kind: "runtime-context" },
      content: [
        {
          type: "image",
          attachment: { ...attachment, attachmentId: "automatic" },
        },
      ],
    },
    {
      id: "real",
      role: "user",
      source: { kind: "user" },
      content: [
        { type: "text", text: "Describe this" },
        { type: "image", attachment },
      ],
    },
  ];
  try {
    const chunks = await collect(h.adapter.stream(h.options));
    const prompt = JSON.parse(
      chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => c.text)
        .join(""),
    );
    assert.deepEqual(prompt, [
      { type: "text", text: "Describe this" },
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
    assert.deepEqual(reads, [attachment]);
    assert(!JSON.stringify(prompt).includes("attachmentId"));
  } finally {
    h.adapter.dispose();
  }
});

test("an agent without image capability refuses the prompt before creating or binding a native session", async () => {
  const h = harness("no-image-capability");
  h.options.messages[0].content = [{ type: "image", attachment: {} }];
  try {
    await assert.rejects(
      () => collect(h.adapter.stream(h.options)),
      (e) => e.code === "ACP_MODALITY",
    );
    assert.equal(h.state().binding, null);
  } finally {
    h.adapter.dispose();
  }
});

test("MCP image results carry image bytes rather than host attachment metadata", async () => {
  const h = harness("normal", ["weather"]);
  const ref = { attachmentId: "private-image", mediaType: "image/png" };
  h.ctx.get = (name) =>
    name === "attachments"
      ? { readImage: async () => ({ ref, data: new Uint8Array([1, 2, 3]) }) }
      : undefined;
  h.ctx.tools.execute = async () => ({
    results: [
      {
        result: {
          isError: false,
          content: [{ type: "image", attachment: ref }],
        },
      },
    ],
  });
  try {
    await collect(h.adapter.stream(h.options));
    const output = h.state().calls.find((c) => c.id === "native-mcp").rawOutput;
    assert.deepEqual(output.content, [
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
    assert(!JSON.stringify(output).includes("private-image"));
  } finally {
    h.adapter.dispose();
  }
});
