import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const lines = createInterface({ input: process.stdin });
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (value) =>
  send({
    method: "session/update",
    params: { sessionId: "native-session", update: value },
  });
let mcpServers = [];
let pendingPrompt;
let permission;
const scenario = process.argv[2];
const availableModels =
  scenario === "empty-models"
    ? []
    : scenario === "model-selection"
      ? [
          { modelId: "gemini-test-medium", name: "Gemini Test (Medium)" },
          { modelId: "gemini-test-high", name: "Gemini Test (High)" },
          { modelId: "gemini-test-low", name: "Gemini Test (Low)" },
        ]
      : [{ modelId: "gemini-test-high", name: "Gemini Test (High)" }];
let selectedModel = availableModels[0]?.modelId;
lines.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id === "elicitation-1") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(m.result ?? m.error) } });
    send({ id: pendingPrompt.id, result: { stopReason: "end_turn" } });
    pendingPrompt = null;
    return;
  }
  if (m.id === "permission-1") {
    permission?.(m.result);
    return;
  }
  const result = (value) => send({ id: m.id, result: value });
  if (m.method === "initialize") {
    if (scenario === "elicitation" && !m.params.clientCapabilities?.elicitation?.form)
      return process.exit(20);
    if (scenario === "catalog-hang") {
      send({ method: "test/catalog-waiting", params: {} });
      return;
    }
    if (
      scenario === "file-storage" &&
      process.env.DBUS_SESSION_BUS_ADDRESS !== "unix:path=/dev/null"
    )
      process.exit(12);
    if (scenario === "catalog-failure") process.exit(13);
    if (m.params.clientInfo.name !== "google-acp-extension") process.exit(7);
    result({
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "test" },
      authMethods: [{ id: "oauth-personal" }],
      agentCapabilities: {
        promptCapabilities: { image: scenario !== "no-image-capability" },
        sessionCapabilities: { resume: {}, close: {} },
        _meta: { antigravity: { systemPrompt: { append: true } } },
      },
    });
  } else if (m.method === "authenticate") {
    if (m.params.methodId !== "oauth-personal") process.exit(8);
    result({});
  } else if (m.method === "session/new" || m.method === "session/resume") {
    if (scenario === "idle-wake" && m.method === "session/resume") process.exit(21);
    if (scenario.startsWith("session-")) {
      update({ sessionUpdate: "usage_update", used: 12000, size: 100000 });
      update({
        sessionUpdate: "available_commands_update",
        availableCommands:
          scenario === "session-no-compact"
            ? []
            : [{ name: "compact", description: "Compact native history" }],
      });
    }
    if (scenario === "slow-catalog") {
      send({ method: "test/catalog-waiting", params: {} });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (m.params._meta?.antigravity?.systemPrompt) process.exit(10);
    mcpServers = m.params.mcpServers;
    result({
      sessionId: "native-session",
      models:
        scenario === "no-models"
          ? undefined
          : {
              availableModels,
              currentModelId: selectedModel,
            },
    });
  } else if (m.method === "session/set_model") {
    if (!availableModels.some((model) => model.modelId === m.params.modelId))
      process.exit(11);
    selectedModel = m.params.modelId;
    if (scenario === "session-metadata")
      update({ sessionUpdate: "usage_update", used: 15000, size: 100000 });
    result({});
  } else if (m.method === "session/close") result({});
  else if (m.method === "session/cancel") {
    if (pendingPrompt) {
      send({ id: pendingPrompt.id, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
  } else if (m.method === "session/prompt") {
    if (scenario === "steering") {
      if (!pendingPrompt) {
        pendingPrompt = m;
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "RUNNING" },
        });
      } else {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "STEER_RECEIVED" },
        });
        result({ stopReason: "end_turn" });
        send({ id: pendingPrompt.id, result: { stopReason: "end_turn" } });
        pendingPrompt = null;
      }
      return;
    }
    pendingPrompt = m;
    if (scenario === "idle-wake") {
      if (m.params.prompt[0]?.text === "next task") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Same transport." } });
        result({ stopReason: "end_turn" });
        return;
      }
      update({ sessionUpdate: "tool_call", toolCallId: "monitor", kind: "other", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Monitor registered." } });
      result({ stopReason: "end_turn" });
      setTimeout(() => {
        send({
          id: "permission-1",
          method: "session/request_permission",
          params: {
            sessionId: "native-session",
            toolCall: { toolCallId: "wake-read", title: "Read monitor result" },
            options: [{ optionId: "allow", kind: "allow_once" }],
          },
        });
        permission = (reply) => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "wake-read", status: "completed" });
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply?.outcome?.optionId === "allow" ? "Monitor woke." : "Monitor denied." } });
          update({ sessionUpdate: "usage_update", used: 100, size: 1000 });
        };
      }, 80);
      return;
    }
    if (scenario.startsWith("background-after-end-turn")) {
      update({ sessionUpdate: "tool_call", toolCallId: "background", kind: "execute", status: "in_progress", rawInput: { command: "fixture" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Still running. " } });
      result({ stopReason: "end_turn" });
      if (scenario === "background-after-end-turn-timeout") return;
      setTimeout(() => {
        update({ sessionUpdate: "tool_call_update", toolCallId: "background", status: "completed" });
        setTimeout(() => {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
          update({ sessionUpdate: "usage_update", used: 100, size: 1000 });
        }, 3100);
      }, 50);
      return;
    }
    if (scenario === "elicitation") {
      send({
        id: "elicitation-1",
        method: "elicitation/create",
        params: {
          sessionId: "native-session",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {
              q1: {
                type: "array",
                title: "Pick toppings",
                items: { anyOf: [{ const: "1", title: "Cheese" }, { const: "2", title: "Olives" }] },
              },
              q1_other: { type: "string" },
            },
          },
        },
      });
      return;
    }
    if (
      scenario.startsWith("session-") &&
      m.params.prompt[0]?.text === "/compact"
    ) {
      if (scenario === "session-compact-hang") return;
      if (scenario === "session-compact-crash") return process.exit(19);
      if (scenario === "session-compact-failed") {
        update({
          sessionUpdate: "compaction_update",
          compactionId: "manual",
          status: "failed",
          error: "Native compaction refused",
        });
        result({ stopReason: "end_turn" });
        return;
      }
      update({
        sessionUpdate: "compaction_update",
        compactionId: "manual",
        status: "in_progress",
      });
      update({
        sessionUpdate: "compaction_update",
        compactionId: "manual",
        status: "completed",
        summary: [{ type: "text", text: "Native retained summary" }],
      });
      update({ sessionUpdate: "usage_update", used: 1000, size: 100000 });
      result({ stopReason: "end_turn" });
      return;
    }
    if (scenario === "session-metadata") {
      update({
        sessionUpdate: "plan",
        entries: [
          { content: "Read sources", status: "completed", priority: "high" },
          {
            content: "Write result",
            status: "in_progress",
            priority: "medium",
          },
        ],
      });
      update({
        sessionUpdate: "notice",
        title: "Native notice",
        description: "Attention required",
        severity: "warning",
      });
      update({
        sessionUpdate: "compaction_update",
        compactionId: "auto",
        status: "in_progress",
      });
      update({
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "auto",
        content: { type: "text", text: "Part one. " },
      });
      update({
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "auto",
        content: { type: "text", text: "Part two." },
      });
      update({
        sessionUpdate: "compaction_update",
        compactionId: "auto",
        status: "completed",
      });
      update({ sessionUpdate: "usage_update", used: 3000, size: 100000 });
    }
    if (scenario === "presentation") {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (text) =>
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      text("BEFORE_TOOL");
      await pause(400);
      update({
        sessionUpdate: "tool_call",
        toolCallId: "terminal",
        kind: "execute",
        title: "printf terminal-ok",
        status: "in_progress",
        rawInput: {
          CommandLine: "printf terminal-ok",
          toolSummary: "Print marker",
        },
      });
      await pause(600);
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "terminal",
        status: "completed",
        rawOutput: { output: "terminal-ok", exit_code: 0 },
      });
      text("AFTER_TERMINAL");
      await pause(400);
      update({
        sessionUpdate: "tool_call",
        toolCallId: "search-sources",
        kind: "search",
        title: "Search docs",
        status: "in_progress",
        rawInput: { query: "Python docs" },
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "search-sources",
        status: "completed",
        _meta: {
          sources: [
            {
              url: "https://docs.python.org/",
              title: "Python documentation",
              snippet: "Official reference",
            },
          ],
          answer: "Python documentation",
        },
      });
      text("AFTER_SEARCH");
      await pause(400);
      update({
        sessionUpdate: "tool_call",
        toolCallId: "search-empty",
        kind: "search",
        title: "Search without returned content",
        status: "completed",
        rawInput: { query: "no returned results" },
      });
      text("FINAL_STREAMING");
      await pause(5000);
      text(" DONE");
      result({ stopReason: "end_turn" });
      pendingPrompt = null;
      return;
    }
    if (scenario === "model-selection") {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: selectedModel },
      });
      result({ stopReason: "end_turn" });
      pendingPrompt = null;
      return;
    }
    if (scenario === "echo-prompt") {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(m.params.prompt) },
      });
      result({ stopReason: "end_turn" });
      pendingPrompt = null;
      return;
    }
    if (scenario === "disabled") {
      update({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal.",
        },
      });
      result({ stopReason: "end_turn" });
      pendingPrompt = null;
      return;
    }
    if (scenario === "crash") process.exit(9);
    if (scenario === "malformed") {
      process.stdout.write("not JSON\n");
      return;
    }
    if (scenario === "hang") return;
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Native reasoning" },
    });
    if (!["permission-empty", "empty-reply"].includes(scenario))
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Starting. " },
      });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "native-read",
      title: "Read native.txt",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "native.txt" },
    });
    if (
      [
        "permission",
        "permission-empty",
        "permission-always",
        "question",
      ].includes(scenario)
    ) {
      const answer = new Promise((resolve) => {
        permission = resolve;
      });
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: "native-session",
          toolCall: {
            toolCallId:
              scenario === "question" ? "interaction_color" : "native-read",
            title:
              scenario === "question" ? "Choose a color" : "Read native.txt",
            rawInput: { path: "native.txt" },
          },
          options:
            scenario === "question"
              ? [
                  { kind: "allow_once", optionId: "red", name: "Red" },
                  { kind: "allow_once", optionId: "blue", name: "Blue" },
                ]
              : scenario === "permission-always"
                ? [
                    { kind: "allow_always", optionId: "always" },
                    { kind: "reject_once", optionId: "deny" },
                  ]
                : [
                    { kind: "allow_once", optionId: "allow" },
                    { kind: "reject_once", optionId: "deny" },
                  ],
        },
      });
      const response = await answer;
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-read",
        status: ["allow", "blue"].includes(response.outcome.optionId)
          ? "completed"
          : "failed",
      });
    } else
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-read",
        status: "completed",
        rawOutput: "Native result",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Read through native agent" },
          },
        ],
      });
    if (mcpServers.length) {
      const desc = mcpServers[0];
      const env = Object.fromEntries(desc.env.map((e) => [e.name, e.value]));
      const child = spawn(desc.command, desc.args, {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const replies = new Map();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const r = JSON.parse(line);
        replies.get(r.id)?.(r.result);
      });
      let seq = 0;
      const call = (method, params = {}) =>
        new Promise((resolve) => {
          const id = ++seq;
          replies.set(id, resolve);
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        });
      await call("initialize", { protocolVersion: "2024-11-05" });
      const { tools } = await call("tools/list");
      const toolInput =
        tools[0].name === "web_reader"
          ? {
              url: process.env.ACP_TEST_WEB_URL ?? "http://127.0.0.1:18750/",
              format: "markdown",
              maxChars: 5000,
            }
          : { query: "hello" };
      update({
        sessionUpdate: "tool_call",
        toolCallId: "native-mcp",
        title: `google-acp-extensions/${tools[0].name}`,
        status: "in_progress",
        rawInput: toolInput,
      });
      const output = await call("tools/call", {
        name: tools[0].name,
        arguments: toolInput,
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "native-mcp",
        status: output.isError ? "failed" : "completed",
        rawOutput: output,
      });
      child.stdin.end();
      await new Promise((resolve) => child.on("close", resolve));
    }
    if (!["permission-empty", "empty-reply"].includes(scenario))
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      });
    if (scenario === "token-usage")
      await new Promise((resolve) => setTimeout(resolve, 50));
    result({
      stopReason: "end_turn",
      ...(scenario === "token-usage"
        ? {
            usage: {
              inputTokens: 2195,
              outputTokens: 63,
              cachedReadTokens: 6647,
              cachedWriteTokens: 0,
              thoughtTokens: 12,
              totalTokens: 8905,
            },
          }
        : {}),
    });
    pendingPrompt = null;
  }
});
