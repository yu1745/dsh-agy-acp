import {
  acpTokenUsage
} from "./chunk-B4XHGPT4.js";
import {
  DshMcpBridge,
  selectMcpTools
} from "./chunk-YBLDFYLJ.js";
import {
  acpReasoning,
  groupAcpModels,
  resolveAcpModelSelection
} from "./chunk-BEG4JNL7.js";
import {
  appendAcpRecord,
  hostAcpRecordWriter
} from "./chunk-45EP4QWY.js";
import {
  AcpConnection,
  AcpRpcError
} from "./chunk-LSQ2VM76.js";
import {
  ACP_BINDING,
  ACP_PROVIDER,
  NativeMessageRecorder,
  NativeToolRecorder,
  acpProjection
} from "./chunk-GUVVMWPW.js";
import {
  ACP_NOTICE,
  NativeSessionUpdates
} from "./chunk-5I4WLZ2F.js";

// src/google-acp.ts
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  createUserMessage
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
var name = "yu-google-acp";
var inject = ["llm", "agents", "tools", "sessionProjections"];
var ACP_PROMPT_POLICY = "native-user-input-v1";
var Config = z.object({
  command: z.string().default("agy"),
  args: z.array(z.string()).default(["acp"]),
  credentialStore: z.union([z.const("auto"), z.const("file")]).default("auto"),
  mcpTools: z.array(z.string()).default([]),
  requestTimeoutMs: z.number().min(1e3).default(18e5)
});
var AsyncQueue = class {
  items = [];
  wake;
  push(item) {
    this.items.push(item);
    this.wake?.();
    this.wake = void 0;
  }
  async next() {
    while (!this.items.length)
      await new Promise((r) => {
        this.wake = r;
      });
    return this.items.shift();
  }
};
var GoogleAcpAdapter = class extends LlmAdapter {
  constructor(ctx, config, projection, writeRecord = appendAcpRecord) {
    super();
    this.ctx = ctx;
    this.config = config;
    this.projection = projection;
    this.writeRecord = writeRecord;
  }
  ctx;
  config;
  projection;
  writeRecord;
  connections = /* @__PURE__ */ new Set();
  active = /* @__PURE__ */ new Set();
  catalog = [];
  catalogSession;
  catalogTask;
  catalogKey;
  catalogConfigKey;
  catalogCredentialVersion;
  catalogRefreshAfter = 0;
  catalogRevision = 0;
  catalogRefreshAgain = false;
  imagePrompts = false;
  disposed = false;
  coordinates = /* @__PURE__ */ new WeakMap();
  providerInfo(provider) {
    return { id: provider, name: "Google \xB7 Antigravity ACP" };
  }
  providerRetryPolicy() {
    return resolveRetryPolicy(
      { mode: "normal", maxRetries: 0 },
      "google-acp.retry"
    );
  }
  async listModels(provider) {
    this.refreshCatalog();
    return [
      {
        provider,
        id: "default",
        name: "Antigravity \xB7 \u8D26\u53F7\u9ED8\u8BA4\u6A21\u578B",
        inputModalities: this.inputModalities()
      },
      ...this.catalog.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: this.inputModalities()
      }))
    ];
  }
  async resolveModel(provider, model) {
    this.refreshCatalog();
    const group = this.catalog.find(
      (m) => m.id === model || m.nativeIds.has(model)
    );
    const reasoning = group ? acpReasoning(
      group,
      group.nativeIds.has(model) ? model : group.defaultNativeId
    ) : void 0;
    return {
      provider,
      id: model,
      name: group?.name ?? model,
      inputModalities: this.inputModalities(),
      ...reasoning ? { reasoning } : {},
      description: "\u5B98\u65B9 ACP \u4EE3\u7406\u6267\u884C\u6574\u8F6E\u4EFB\u52A1\uFF1B\u6A21\u578B\u3001\u4E0A\u4E0B\u6587\u548C\u539F\u751F\u5DE5\u5177\u7531 Antigravity \u7BA1\u7406\u3002"
    };
  }
  /** Model enumeration never waits for filesystem, authentication or ACP RPC. */
  inputModalities() {
    return this.imagePrompts ? ["text", "image"] : ["text"];
  }
  refreshCatalog() {
    if (this.disposed) return;
    const configKey = JSON.stringify([
      this.config.command,
      this.config.args,
      this.config.credentialStore ?? "auto"
    ]);
    if (configKey !== this.catalogConfigKey) {
      const hadConfig = this.catalogConfigKey !== void 0;
      const refreshing = this.catalogTask !== void 0;
      this.catalogConfigKey = configKey;
      this.catalogCredentialVersion = void 0;
      this.catalogRefreshAfter = 0;
      if (hadConfig) this.clearCatalog();
      if (refreshing) this.catalogRefreshAgain = true;
    }
    if (this.catalogTask) return;
    let revision = this.catalogRevision;
    this.catalogTask = Promise.resolve().then(async () => {
      const version = await this.credentialVersion();
      if (this.disposed || configKey !== this.catalogConfigKey || revision !== this.catalogRevision)
        return;
      if (version !== this.catalogCredentialVersion) {
        if (this.catalogCredentialVersion !== void 0) {
          this.clearCatalog();
          this.catalogRefreshAfter = 0;
        }
        this.catalogCredentialVersion = version;
      }
      if (Date.now() < this.catalogRefreshAfter) return;
      this.catalogRefreshAfter = Date.now() + 3e4;
      revision = this.catalogRevision;
      await this.discover(revision);
    }).catch(() => {
      if (!this.disposed && revision === this.catalogRevision)
        this.clearCatalog();
    }).finally(() => {
      this.catalogTask = void 0;
      if (this.catalogRefreshAgain && !this.disposed) {
        this.catalogRefreshAgain = false;
        this.refreshCatalog();
      }
    });
  }
  async credentialVersion() {
    if (this.config.credentialStore !== "file") return "auto";
    const flag = (...names) => {
      for (let i = 0; i < this.config.args.length; i++) {
        const arg = this.config.args[i];
        for (const name2 of names) {
          if (arg === name2) return this.config.args[i + 1];
          if (arg.startsWith(name2 + "=")) return arg.slice(name2.length + 1);
        }
      }
    };
    const gemini = resolve(
      homedir(),
      flag("--gemini-dir", "--gemini_dir") ?? ".gemini"
    );
    const app = resolve(
      gemini,
      flag("--app-data-dir", "--app_data_dir") ?? "antigravity-cli"
    );
    try {
      const info = await stat(join(app, "antigravity-oauth-token"));
      return JSON.stringify([
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs
      ]);
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }
  connection(cwd) {
    if (this.disposed)
      throw new LlmError("Google ACP plugin is disposed.", "ACP_DISPOSED");
    const rpc = new AcpConnection(
      this.config.command,
      this.config.args,
      cwd,
      this.config.credentialStore
    );
    this.connections.add(rpc);
    return rpc;
  }
  async initialize(rpc) {
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {}, notices: {} } },
      clientInfo: {
        name: "google-acp-extension",
        title: "Google ACP Extension",
        version: "0.1.0"
      }
    });
    if (init.protocolVersion !== 1 || !/Antigravity/i.test(init.agentInfo?.name ?? ""))
      throw new LlmError(
        "Google ACP requires the unmodified official Antigravity ACP agent.",
        "ACP_AGENT"
      );
    if (!init.authMethods?.some((m) => m.id === "oauth-personal"))
      throw new LlmError(
        "Official ACP agent does not offer personal Google login. Run agy acp --login.",
        "AUTH"
      );
    await rpc.request("authenticate", { methodId: "oauth-personal" });
    this.imagePrompts = init.agentCapabilities?.promptCapabilities?.image === true;
    return init;
  }
  async discover(revision = this.catalogRevision) {
    const cwd = await mkdtemp(join(tmpdir(), "google-acp-catalog-"));
    let rpc;
    let timer;
    try {
      if (this.disposed || revision !== this.catalogRevision) return;
      rpc = this.connection(cwd);
      timer = setTimeout(
        () => rpc?.close(new AcpRpcError("ACP catalog discovery timed out.")),
        15e3
      );
      timer.unref();
      const init = await this.initialize(rpc);
      const session = await rpc.request("session/new", { cwd, mcpServers: [] });
      if (!this.disposed && revision === this.catalogRevision) {
        if (Array.isArray(session.models?.availableModels))
          this.updateCatalog(session);
        else this.clearCatalog();
      }
      if (init.agentCapabilities?.sessionCapabilities?.close)
        await rpc.request("session/close", { sessionId: session.sessionId }).catch(() => {
        });
    } finally {
      clearTimeout(timer);
      rpc?.close();
      if (rpc) this.connections.delete(rpc);
      await rm(cwd, { recursive: true, force: true });
    }
  }
  updateCatalog(session) {
    if (this.disposed) return;
    if (Array.isArray(session.models?.availableModels)) {
      this.catalogRevision++;
      this.catalogRefreshAfter = Date.now() + 3e4;
      const key = JSON.stringify([session.models, session.configOptions]);
      this.catalogSession = session;
      this.catalog = groupAcpModels(session);
      if (key !== this.catalogKey) {
        this.catalogKey = key;
        this.ctx.emit?.("llm/models-updated", ACP_PROVIDER);
      }
    }
  }
  clearCatalog() {
    if (this.disposed) return;
    this.catalogRevision++;
    const changed = this.catalogSession !== void 0;
    this.catalog = [];
    this.catalogSession = void 0;
    this.catalogKey = void 0;
    if (changed) this.ctx.emit?.("llm/models-updated", ACP_PROVIDER);
  }
  async preparePrompt(messages, signal) {
    const images = /* @__PURE__ */ new Map();
    for (const message of messages) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== "image") continue;
        if (!this.imagePrompts)
          throw new LlmError(
            "\u5B98\u65B9 ACP \u5F53\u524D\u672A\u63D0\u4F9B\u56FE\u7247\u8F93\u5165\u80FD\u529B\u3002",
            "ACP_MODALITY"
          );
        const attachments = this.ctx.get("attachments");
        if (!attachments || !block.attachment)
          throw new LlmError("\u56FE\u7247\u9644\u4EF6\u4E0D\u53EF\u7528\u3002", "ACP_MODALITY");
        const image = await attachments.readImage(block.attachment, signal);
        images.set(block, {
          data: Buffer.from(image.data).toString("base64"),
          mimeType: image.ref.mediaType
        });
      }
    }
    return buildAcpPrompt(messages, images);
  }
  async *stream(options) {
    if (options.provider !== ACP_PROVIDER)
      throw new LlmError("Invalid Google ACP provider route.", "ACP_ROUTE");
    if (options.purpose)
      throw new LlmError(
        "Google ACP is an interactive agent backend; auxiliary model calls are disabled.",
        "ACP_PURPOSE"
      );
    const agent = options.sessionId ? this.ctx.agents.get(options.sessionId) : void 0;
    if (!agent)
      throw new LlmError(
        "Google ACP requires a live DSH session.",
        "ACP_SESSION"
      );
    if (this.active.has(agent.id))
      throw new LlmError(
        "An ACP turn is already running for this session.",
        "ACP_BUSY"
      );
    if (agent.session.header.origin === "subagent")
      throw new LlmError(
        "Consumer Google ACP access is reserved for interactive root sessions.",
        "ACP_INTERACTIVE_ONLY"
      );
    const previous = this.projection.stateOf(agent.session).binding;
    if (previous && (previous.owner !== agent.id || previous.bad))
      throw new LlmError(
        "Previous ACP turn has an uncertain outcome or belongs to a fork. Use /google-acp-reset or start a new session.",
        "ACP_RESUME"
      );
    if (previous && previous.promptPolicy !== ACP_PROMPT_POLICY)
      throw new LlmError(
        "This native session used an older context policy. Start a new conversation or run /google-acp-reset before sending a new task.",
        "ACP_CONTEXT_POLICY"
      );
    if (previous && (previous.credentialStore ?? "auto") !== (this.config.credentialStore ?? "auto"))
      throw new LlmError(
        "The official credential store changed. Use /google-acp-reset or start a new conversation before continuing.",
        "ACP_AUTH_CONTEXT"
      );
    const pending = messagesAfterAnchor(
      options.messages,
      previous?.anchor,
      previous?.historyHash
    ).filter((message) => {
      const delivered = previous?.steered?.find((m) => m.id === message.id);
      if (!delivered) return true;
      if (delivered.hash !== historyHash([message]))
        throw new LlmError(
          "A delivered steering message was edited; reset the native session.",
          "ACP_HISTORY"
        );
      return false;
    });
    if (!pending.length && previous?.steered?.length) {
      this.writeRecord(agent.session, ACP_BINDING, {
        ...previous,
        anchor: options.messages.at(-1)?.id ?? previous.anchor,
        historyHash: historyHash(options.messages),
        steered: []
      });
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (!pending.length)
      throw new LlmError(
        "No new messages to send to the official ACP agent.",
        "ACP_EMPTY"
      );
    const anchor = options.messages.at(-1)?.id ?? null;
    if (!anchor)
      throw new LlmError(
        "ACP session messages require durable identities.",
        "ACP_SESSION"
      );
    this.active.add(agent.id);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let rpc;
    let bridge;
    let recorder;
    let messageRecorder;
    let toolSet;
    let nativeSessionId;
    let accepted = false;
    let stopSteering;
    let cancelTimer;
    const cancel = () => {
      if (!rpc) return;
      if (nativeSessionId)
        rpc.notify("session/cancel", { sessionId: nativeSessionId });
      cancelTimer ??= setTimeout(
        () => rpc?.close(new LlmError("ACP turn cancelled.", "ABORTED")),
        2500
      );
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      controller.signal.throwIfAborted();
      const cwd = agent.session.header.cwd;
      if (!cwd)
        throw new LlmError(
          "Select a workspace before using Google ACP.",
          "ACP_WORKSPACE"
        );
      rpc = this.connection(cwd);
      let nativeConfig;
      const nativeUpdates = new NativeSessionUpdates(
        (type, data) => this.writeRecord(agent.session, type, data),
        (update) => {
          if (Array.isArray(update.configOptions)) {
            nativeConfig = update.configOptions;
            this.updateCatalog({ ...session, configOptions: nativeConfig });
          }
        }
      );
      rpc.onNotification = (method, params) => {
        if (method === "session/update") nativeUpdates.receive(params);
      };
      const init = await this.initialize(rpc);
      controller.signal.throwIfAborted();
      const prompt = await this.preparePrompt(pending, controller.signal);
      if (!prompt.length)
        throw new LlmError(
          "No user task to send to the official ACP agent.",
          "ACP_EMPTY"
        );
      const boundary = this.ctx.agents.turnBoundaryOf(agent.session);
      const turn = boundary.lastTurn;
      const step = this.coordinates.get(agent)?.step ?? 1;
      let schemas = [];
      if (this.config.mcpTools.length) {
        toolSet = await this.ctx.tools.resolve({
          agent,
          modelSelection: { provider: options.provider, model: options.model },
          signal: controller.signal
        });
        schemas = selectMcpTools(
          this.ctx.tools.schemas(agent, toolSet),
          this.config.mcpTools
        );
      }
      if (schemas.length) {
        bridge = new DshMcpBridge(schemas, async (name2, args) => {
          controller.signal.throwIfAborted();
          const id = `extension-${randomUUID()}`;
          try {
            const batch = await this.ctx.tools.execute({
              calls: [
                {
                  type: "tool-call",
                  id,
                  name: name2,
                  arguments: JSON.stringify(args)
                }
              ],
              signal: controller.signal,
              agent,
              toolSet
            });
            const result = batch.results[0]?.result;
            if (!result) throw Error("DSH executor returned no tool result");
            const content = await Promise.all(
              result.content.map(async (b) => {
                if (b.type === "text") return { type: "text", text: b.text };
                if (b.type === "image" && b.attachment) {
                  const attachments = this.ctx.get("attachments");
                  if (!attachments)
                    throw new Error("Image content is unavailable.");
                  const image = await attachments.readImage(
                    b.attachment,
                    controller.signal
                  );
                  return {
                    type: "image",
                    data: Buffer.from(image.data).toString("base64"),
                    mimeType: image.ref.mediaType
                  };
                }
                return { type: "text", text: JSON.stringify(b) };
              })
            );
            if (batch.concluded)
              content.push({
                type: "text",
                text: "This tool requests that this turn now conclude. Return your final response without further tools."
              });
            return { content, isError: result.isError };
          } catch (e) {
            throw e;
          }
        });
        await bridge.start();
      }
      const fields = {
        cwd,
        mcpServers: bridge ? [bridge.descriptor()] : []
      };
      if (previous && !init.agentCapabilities?.sessionCapabilities?.resume)
        throw new LlmError(
          "Official ACP agent cannot resume sessions; refusing to replay the task.",
          "ACP_RESUME"
        );
      const session = await rpc.request(
        previous ? "session/resume" : "session/new",
        {
          ...fields,
          ...previous ? { sessionId: previous.nativeSessionId } : {}
        }
      );
      nativeSessionId = previous?.nativeSessionId ?? session.sessionId;
      if (typeof nativeSessionId !== "string" || !nativeSessionId)
        throw new LlmError(
          "Invalid native ACP session identity.",
          "ACP_SESSION"
        );
      nativeUpdates.bind(nativeSessionId);
      recorder = new NativeToolRecorder(
        agent.session,
        nativeSessionId,
        turn,
        (type, data) => this.writeRecord(agent.session, type, data),
        step
      );
      messageRecorder = new NativeMessageRecorder(
        agent.session,
        nativeSessionId,
        turn,
        step,
        (type, data) => this.writeRecord(agent.session, type, data)
      );
      this.updateCatalog({
        ...session,
        ...nativeConfig ? { configOptions: nativeConfig } : {}
      });
      const nativeModel = resolveAcpModelSelection(
        Array.isArray(session.models?.availableModels) ? session : this.catalogSession ?? session,
        options.model,
        options.reasoningEffort
      );
      const queue = new AsyncQueue();
      let blockedPermission;
      rpc.onNotification = (method, params) => {
        if (method !== "session/update" || params?.sessionId !== nativeSessionId)
          return;
        const u = params.update;
        nativeUpdates.receive(params);
        if (u?.sessionUpdate === "notice" && typeof u.title === "string")
          this.writeRecord(agent.session, ACP_NOTICE, {
            nativeSessionId,
            turn,
            step,
            id: randomUUID(),
            title: u.title.slice(0, 1024),
            description: typeof u.description === "string" ? u.description.slice(0, 4096) : "",
            severity: typeof u.severity === "string" ? u.severity.slice(0, 64) : "info"
          });
        if (u?.sessionUpdate === "plan" && Array.isArray(u.entries)) {
          const todos = u.entries.slice(0, 256).flatMap(
            (entry) => typeof entry?.content === "string" && ["pending", "in_progress", "completed"].includes(entry.status) ? [
              {
                content: entry.content.slice(0, 4096),
                status: entry.status
              }
            ] : []
          );
          agent.session.append("todo/write", { todos });
        }
        const compaction = nativeUpdates.compaction(u);
        if (compaction) {
          messageRecorder.tool(compaction.toolCallId);
          recorder.update(compaction);
        }
        if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
          const info = JSON.stringify([u.title, u._meta, u.rawInput]);
          const origin = info.includes("google-acp-extensions") || schemas.some((t) => info.includes(t.mcpName)) ? "DSH \xB7 MCP" : "Antigravity";
          try {
            messageRecorder.tool(u.toolCallId);
            recorder.update(u, origin);
          } catch (error) {
            queue.push({ type: "error", error });
            cancel();
          }
        } else if (["agent_message_chunk", "agent_thought_chunk"].includes(
          u?.sessionUpdate
        ) && u.content?.type === "text") {
          messageRecorder.delta(
            u.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text",
            u.content.text
          );
          queue.push({
            type: "delta",
            kind: u.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text",
            text: u.content.text
          });
        }
      };
      rpc.onRequest = async (method, params) => {
        if (method !== "session/request_permission" || params?.sessionId !== nativeSessionId)
          throw new AcpRpcError("Unsupported ACP client request", -32601);
        const call = params.toolCall ?? {};
        messageRecorder.tool(call.toolCallId);
        if (call.toolCallId?.startsWith("interaction_")) {
          recorder.update({ ...call, status: "waiting_input" });
          const service = this.ctx.get("userQuestions");
          if (!service || !params.options?.length)
            return { outcome: { outcome: "cancelled" } };
          const labels = params.options.map(
            (o, i) => `${i + 1}. ${o.name ?? o.optionId}`
          );
          const answer = await service.ask({
            agent,
            signal: controller.signal,
            questions: [
              {
                id: call.toolCallId,
                header: "Antigravity",
                question: call.title ?? "\u8BF7\u9009\u62E9",
                options: labels.map((label) => ({ label })),
                multiSelect: false
              }
            ]
          });
          const choice = answer.answers?.find(
            (a) => a.id === call.toolCallId
          );
          const index2 = choice?.selected?.length === 1 && !choice.custom ? labels.indexOf(choice.selected[0]) : -1;
          recorder.update({
            ...call,
            status: index2 >= 0 ? "completed" : "cancelled"
          });
          return index2 >= 0 ? {
            outcome: {
              outcome: "selected",
              optionId: params.options[index2].optionId
            }
          } : { outcome: { outcome: "cancelled" } };
        }
        recorder.update({ ...call, status: "waiting_approval" });
        const allow = params.options?.find((o) => o.kind === "allow_once");
        const reject = params.options?.find(
          (o) => o.kind === "reject_once"
        );
        const preset = fullAccessPreset(this.ctx, agent.session);
        const outcome = controller.signal.aborted ? "cancelled" : allow && preset ? "allowed-once" : allow && this.ctx.get("approval") ? await this.ctx.get("approval").request({
          agent,
          toolName: call.title ?? "Antigravity tool",
          reason: JSON.stringify({
            title: call.title ?? "ACP permission",
            input: call.rawInput ?? null,
            locations: call.locations ?? []
          }),
          signal: controller.signal
        }) : "unavailable";
        const message = outcome === "allowed-once" ? preset ? "\u5DF2\u6309\u5F53\u524D\u4F1A\u8BDD\u7684\u5B8C\u6574\u8BBF\u95EE\u6743\u9650\u5141\u8BB8\u672C\u6B21\u8C03\u7528\u3002" : "\u5DF2\u5BA1\u6279\u5141\u8BB8\u672C\u6B21\u8C03\u7528\u3002" : outcome === "rejected" ? "\u6B64\u8C03\u7528\u7684\u5BA1\u6279\u88AB\u62D2\u7EDD\uFF0C\u64CD\u4F5C\u672A\u83B7\u6267\u884C\u8BB8\u53EF\u3002" : outcome === "cancelled" ? "\u672C\u6B21\u5BA1\u6279\u5DF2\u53D6\u6D88\uFF0C\u64CD\u4F5C\u672A\u83B7\u6267\u884C\u8BB8\u53EF\u3002" : "\u672C\u6B21\u8C03\u7528\u6CA1\u6709\u53EF\u7528\u7684\u5355\u6B21\u5BA1\u6279\u6388\u6743\uFF0C\u64CD\u4F5C\u672A\u83B7\u6267\u884C\u8BB8\u53EF\u3002";
        if (outcome !== "allowed-once")
          blockedPermission = {
            code: "ACP_PERMISSION_DENIED",
            message: `${message} \u5B98\u65B9\u4EE3\u7406\u4E5F\u672A\u8FD4\u56DE\u6700\u7EC8\u7B54\u590D\uFF0C\u8BF7\u68C0\u67E5\u4F1A\u8BDD\u6743\u9650\u540E\u91CD\u65B0\u53D1\u9001\u4EFB\u52A1\u3002`
          };
        const selected = outcome === "allowed-once" ? allow : reject;
        recorder.update({
          ...call,
          status: outcome === "allowed-once" ? "in_progress" : "failed",
          permission: {
            outcome: ["allowed-once", "rejected", "cancelled"].includes(outcome) ? outcome : "unavailable",
            source: preset && allow ? "session-preset" : "approval-service",
            ...preset && allow ? { preset } : {},
            message
          }
        });
        return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
      };
      if (nativeModel) {
        await rpc.request("session/set_model", {
          sessionId: nativeSessionId,
          modelId: nativeModel
        });
      }
      controller.signal.throwIfAborted();
      const binding = {
        owner: agent.id,
        nativeSessionId,
        anchor,
        historyHash: historyHash(options.messages),
        promptPolicy: ACP_PROMPT_POLICY,
        credentialStore: this.config.credentialStore ?? "auto",
        bad: true,
        steered: (previous?.steered ?? []).filter(
          (entry) => !options.messages.some((message) => message.id === entry.id)
        )
      };
      this.writeRecord(agent.session, ACP_BINDING, binding);
      accepted = true;
      const task = rpc.request(
        "session/prompt",
        { sessionId: nativeSessionId, prompt },
        this.config.requestTimeoutMs
      );
      const steering = /* @__PURE__ */ new Set();
      let submissions = Promise.resolve();
      const sendSteering = ({ agent: owner, message }) => {
        if (owner?.id !== agent.id || controller.signal.aborted || !isUserTask(message) || !agent.inbox?.nextStep.some((m) => m.id === message.id) || binding.steered.some((m) => m.id === message.id))
          return;
        const entry = { id: message.id, hash: historyHash([message]) };
        try {
          this.writeRecord(agent.session, ACP_BINDING, {
            ...binding,
            steered: [...binding.steered, entry]
          });
        } catch (error) {
          queue.push({ type: "error", error });
          cancel();
          return;
        }
        binding.steered.push(entry);
        const submitted = submissions.then(async () => {
          const extra = await this.preparePrompt([message], controller.signal);
          controller.signal.throwIfAborted();
          if (!extra.length)
            throw new LlmError("Empty steering input", "ACP_EMPTY");
          const completion = rpc.request(
            "session/prompt",
            { sessionId: nativeSessionId, prompt: extra },
            this.config.requestTimeoutMs
          );
          void completion.catch(() => {
          });
          messageRecorder.finish();
          this.writeRecord(agent.session, ACP_NOTICE, {
            nativeSessionId,
            turn,
            step,
            id: `steer:${message.id}`,
            title: "\u63D2\u8BDD\u5DF2\u63D0\u4EA4\u81F3 ACP",
            description: "\u5DF2\u6CBF\u5F53\u524D\u8FDE\u63A5\u53D1\u9001\uFF1B\u7531\u539F\u751F\u4EE3\u7406\u5728\u6267\u884C\u8FB9\u754C\u63A5\u6536\u3002",
            severity: "info"
          });
          return { completion };
        });
        submissions = submitted.then(
          () => {
          },
          () => {
          }
        );
        const delivery = submitted.then(({ completion }) => completion);
        steering.add(delivery);
        void delivery.catch((error) => {
          queue.push({ type: "error", error });
          cancel();
        });
      };
      if (this.ctx.on) {
        const inserted = this.ctx.on("agent/inbox/inserted", sendSteering);
        const discarded = this.ctx.on(
          "agent/inbox/discarded",
          ({ agent: owner, message }) => {
            if (owner?.id !== agent.id || controller.signal.aborted || !binding.steered.some((m) => m.id === message.id))
              return;
            queue.push({
              type: "error",
              error: new LlmError(
                "\u5DF2\u63D0\u4EA4\u7ED9 ACP \u7684\u63D2\u8BDD\u88AB\u4FEE\u6539\u6216\u79FB\u9664\uFF0C\u65E0\u6CD5\u64A4\u56DE\u539F\u751F\u4E0A\u4E0B\u6587\u3002\u8BF7\u65B0\u5EFA\u4F1A\u8BDD\u6216\u6267\u884C /google-acp-reset\u3002",
                "ACP_HISTORY"
              )
            });
            cancel();
          }
        );
        stopSteering = () => {
          inserted();
          discarded();
        };
      }
      for (const message of agent.inbox?.nextStep ?? [])
        sendSteering({ agent, message });
      void task.then(
        async (result) => {
          try {
            let size;
            do {
              size = steering.size;
              await Promise.all(steering);
            } while (size !== steering.size);
            stopSteering?.();
            stopSteering = void 0;
            queue.push({ type: "done", result });
          } catch (error) {
            queue.push({ type: "error", error });
          }
        },
        (error) => queue.push({ type: "error", error })
      );
      let index = -1;
      let current;
      let visibleText = "";
      while (true) {
        const item = await queue.next();
        if (item.type === "delta") {
          if (current?.type !== item.kind) {
            if (current) yield { type: "block-end", index, block: current };
            current = { type: item.kind, text: "" };
            index++;
            yield { type: "block-start", index, blockType: current.type };
          }
          current.text += item.text;
          if (item.kind === "text") visibleText += item.text;
          yield item.kind === "text" ? { type: "text-delta", index, text: item.text } : { type: "reasoning-delta", index, text: item.text };
          continue;
        }
        if (current) yield { type: "block-end", index, block: current };
        if (item.type === "error") throw item.error;
        const stop = item.result?.stopReason;
        messageRecorder.finish(
          stop === "cancelled" || controller.signal.aborted ? "interrupted" : "settled"
        );
        this.writeRecord(agent.session, ACP_BINDING, {
          ...binding,
          bad: false
        });
        accepted = false;
        const usage = steering.size === 0 ? acpTokenUsage(item.result?.usage) : void 0;
        if (usage) yield { type: "usage", usage };
        if (/service has been disabled in this account|account (?:has been |is )?(?:suspended|disabled)/i.test(
          visibleText
        ))
          throw new LlmError(
            "Google reports that this account's Antigravity service is disabled. Follow the official appeal process; the plugin will not retry or switch authentication.",
            "ACCOUNT_DISABLED"
          );
        if (stop === "cancelled" || controller.signal.aborted) {
          recorder.finish("cancelled");
          yield {
            type: "finish",
            reason: {
              kind: "aborted",
              failure: {
                code: "ABORTED",
                message: "Official ACP turn cancelled."
              }
            }
          };
        } else if (stop === "end_turn") {
          recorder.finish("incomplete");
          if (!visibleText.trim())
            throw new LlmError(
              blockedPermission?.message ?? "\u5B98\u65B9 ACP \u4EE3\u7406\u7ED3\u675F\u4E86\u56DE\u5408\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE\u6700\u7EC8\u7B54\u590D\u3002\u8BF7\u68C0\u67E5\u8C03\u7528\u8BB0\u5F55\u540E\u91CD\u65B0\u53D1\u9001\u4EFB\u52A1\u3002",
              blockedPermission?.code ?? "ACP_EMPTY_REPLY"
            );
          yield { type: "finish", reason: { kind: "stop" } };
        } else if (stop === "max_tokens") {
          recorder.finish("incomplete");
          yield { type: "finish", reason: { kind: "max-tokens" } };
        } else
          throw new LlmError(
            `Official ACP agent stopped: ${stop ?? "missing stopReason"}`,
            "ACP_STOP"
          );
        break;
      }
    } catch (error) {
      messageRecorder?.finish("interrupted");
      recorder?.finish(controller.signal.aborted ? "cancelled" : "failed");
      if (error instanceof AcpRpcError && error.code === -32e3)
        throw new LlmError(
          "Google sign-in required. Run agy acp --login with your subscription account.",
          "AUTH"
        );
      throw error;
    } finally {
      stopSteering?.();
      messageRecorder?.finish("interrupted");
      if (accepted && !controller.signal.aborted) controller.abort();
      controller.signal.removeEventListener("abort", cancel);
      controller.abort();
      clearTimeout(cancelTimer);
      options.signal?.removeEventListener("abort", abort);
      rpc?.close();
      if (rpc) this.connections.delete(rpc);
      await bridge?.close();
      toolSet?.dispose();
      this.active.delete(agent.id);
    }
  }
  isBusy(agent) {
    return this.active.has(agent.id);
  }
  async compact(agent, signal) {
    signal.throwIfAborted();
    if (this.active.has(agent.id))
      throw new Error("\u8BF7\u5148\u505C\u6B62\u5F53\u524D ACP \u4EFB\u52A1\uFF0C\u518D\u538B\u7F29\u4E0A\u4E0B\u6587\u3002");
    const binding = this.projection.stateOf(agent.session).binding;
    if (!binding)
      return { kind: "success", text: "\u5C1A\u672A\u5EFA\u7ACB\u5B98\u65B9 ACP \u4E0A\u4E0B\u6587\uFF0C\u65E0\u9700\u538B\u7F29\u3002" };
    if (binding.owner !== agent.id || binding.bad || binding.promptPolicy !== ACP_PROMPT_POLICY || (binding.credentialStore ?? "auto") !== (this.config.credentialStore ?? "auto"))
      throw new Error(
        "\u539F\u751F ACP \u4F1A\u8BDD\u72B6\u6001\u6216\u8BA4\u8BC1\u914D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5148\u65B0\u5EFA\u4F1A\u8BDD\u6216\u6267\u884C /google-acp-reset\u3002"
      );
    return agent.runMaintenance(async (maintenanceSignal) => {
      const abort = AbortSignal.any([signal, maintenanceSignal]);
      abort.throwIfAborted();
      this.active.add(agent.id);
      let rpc;
      let cancelTimer;
      let started = false;
      const cancel = () => {
        rpc?.notify("session/cancel", { sessionId: binding.nativeSessionId });
        cancelTimer ??= setTimeout(
          () => rpc?.close(new Error("ACP compaction cancelled")),
          2500
        );
      };
      abort.addEventListener("abort", cancel, { once: true });
      try {
        const cwd = agent.session.header.cwd;
        if (!cwd) throw new Error("\u8BF7\u5148\u9009\u62E9\u5DE5\u4F5C\u533A\u3002");
        rpc = this.connection(cwd);
        const updates = new NativeSessionUpdates(
          (type, data) => this.writeRecord(agent.session, type, data)
        );
        const turn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn;
        const recorder = new NativeToolRecorder(
          agent.session,
          binding.nativeSessionId,
          turn,
          (type, data) => this.writeRecord(agent.session, type, data)
        );
        let response = "";
        rpc.onNotification = (method, params) => {
          if (method !== "session/update") return;
          updates.receive(params);
          if (params?.sessionId !== updates.id) return;
          const u = params.update;
          const compaction = updates.compaction(u);
          if (compaction) recorder.update(compaction);
          if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
            response = (response + u.content.text).slice(0, 64 * 1024);
        };
        rpc.onRequest = async () => ({ outcome: { outcome: "cancelled" } });
        const init = await this.initialize(rpc);
        abort.throwIfAborted();
        if (!init.agentCapabilities?.sessionCapabilities?.resume)
          throw new Error("\u5B98\u65B9 ACP \u4E0D\u652F\u6301\u6062\u590D\u4F1A\u8BDD\uFF0C\u672A\u53D1\u9001\u538B\u7F29\u8BF7\u6C42\u3002");
        await rpc.request("session/resume", {
          cwd,
          mcpServers: [],
          sessionId: binding.nativeSessionId
        });
        updates.bind(binding.nativeSessionId);
        await updates.requireCommand("compact", abort);
        abort.throwIfAborted();
        this.writeRecord(agent.session, ACP_BINDING, { ...binding, bad: true });
        started = true;
        const result = await rpc.request(
          "session/prompt",
          {
            sessionId: binding.nativeSessionId,
            prompt: [{ type: "text", text: "/compact" }]
          },
          this.config.requestTimeoutMs
        );
        this.writeRecord(agent.session, ACP_BINDING, {
          ...binding,
          bad: false
        });
        started = false;
        abort.throwIfAborted();
        if (result?.stopReason !== "end_turn")
          throw new Error(
            `\u5B98\u65B9 ACP \u538B\u7F29\u672A\u5B8C\u6210\uFF1A${result?.stopReason ?? "missing stopReason"}`
          );
        const failure = updates.compactionFailure();
        if (failure) throw new Error(failure);
        await this.ctx.get("sessions")?.flush(agent.session);
        return {
          kind: "success",
          text: response.trim() || "\u5B98\u65B9 ACP \u5DF2\u5904\u7406 /compact\uFF1B\u5360\u7528\u4EE5\u6700\u65B0\u4E0A\u62A5\u4E3A\u51C6\uFF0C\u672C\u5730\u8BB0\u5F55\u4FDD\u7559\u3002"
        };
      } finally {
        if (started) cancel();
        abort.removeEventListener("abort", cancel);
        clearTimeout(cancelTimer);
        rpc?.close();
        if (rpc) this.connections.delete(rpc);
        this.active.delete(agent.id);
      }
    });
  }
  dispose() {
    this.disposed = true;
    for (const rpc of this.connections) rpc.close();
    this.connections.clear();
  }
};
function fullAccessPreset(ctx, session) {
  const service = ctx.get("permissionPresets");
  if (!service) return;
  try {
    const preset = service.current(session);
    if (!preset || preset === "auto" || preset === "custom") return;
    const spec = service.resolve(preset);
    if (spec.sandbox === "danger-full-access" && spec.approval === "never")
      return preset;
  } catch {
  }
}
function historyHash(messages) {
  return createHash("sha256").update(
    JSON.stringify(
      messages.filter(isUserTask).map((m) => [m.role, m.id ?? null, m.content])
    )
  ).digest("hex");
}
function messagesAfterAnchor(messages, anchor, expectedHash) {
  let start = 0;
  if (anchor) {
    const index = messages.findIndex((m) => m.id === anchor);
    if (index < 0)
      throw new LlmError(
        "DSH history no longer matches the ACP session. Use /google-acp-reset or start a new session.",
        "ACP_HISTORY"
      );
    if (expectedHash && historyHash(messages.slice(0, index + 1)) !== expectedHash)
      throw new LlmError(
        "DSH history was edited after submission to ACP. Use /google-acp-reset or start a new session.",
        "ACP_HISTORY"
      );
    start = index + 1;
  }
  const tasks = messages.slice(start).filter(isUserTask);
  return anchor ? tasks : tasks.slice(-1);
}
function isUserTask(message) {
  return message.role === "user" && (message.source === void 0 || message.source?.kind === "user");
}
function buildAcpPrompt(messages, images) {
  const prompt = [];
  for (const m of messages.filter(isUserTask)) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of content ?? []) {
      if (b.type === "image") {
        const image = images?.get(b);
        if (image) {
          prompt.push({ type: "image", ...image });
          continue;
        }
        throw new LlmError(
          "Image input requires an admitted attachment and native ACP image capability; text only otherwise.",
          "ACP_MODALITY"
        );
      }
      if (b.type === "text")
        prompt.push({
          type: "text",
          text: b.text
        });
      else if (b.type !== "reasoning")
        throw new LlmError(
          "This ACP bridge currently supports user text only.",
          "ACP_MODALITY"
        );
    }
  }
  return prompt;
}
async function apply(ctx, config) {
  if (config.args[0] !== "acp" || config.args.some(
    (s) => /^(?:-p|--prompt|--dangerously-skip-permissions|--override_user_agent_name|--cloud_code_endpoint|--worker)(?:=|$)/.test(
      s
    )
  ))
    throw new Error(
      "Google subscription access requires the official agy acp runtime and its normal permissions."
    );
  const projection = await ctx.sessionProjections.register(
    acpProjection
  );
  const writeRecord = await hostAcpRecordWriter();
  const adapter = new GoogleAcpAdapter(ctx, config, projection, writeRecord);
  ctx.reflect.provide("yuGoogleAcp", adapter);
  ctx.llm.registerAdapter([ACP_PROVIDER], adapter);
  ctx.on("agent/request", async (payload, next) => {
    adapter.coordinates.set(payload.agent, {
      turn: payload.turn,
      step: payload.step
    });
    return next();
  });
  ctx.on("dispose", () => adapter.dispose());
  ctx.on("dispose", () => projection.dispose());
  ctx.inject(["commands"], (ready) => {
    ready.commands.register({
      name: "google-acp-reset",
      description: "\u65B0\u5EFA\u5B98\u65B9 ACP \u4E0A\u4E0B\u6587\uFF0C\u4FDD\u7559 DSH \u5BF9\u8BDD\u548C\u8C03\u7528\u8BB0\u5F55",
      handler({ agent }) {
        if (agent.status !== "idle" || adapter.isBusy(agent))
          return {
            kind: "error",
            text: "\u8BF7\u5148\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u518D\u91CD\u7F6E ACP \u4E0A\u4E0B\u6587\u3002"
          };
        writeRecord(agent.session, ACP_BINDING, { reset: true });
        return {
          kind: "success",
          text: "\u4E0B\u6B21 Google ACP \u56DE\u590D\u5C06\u65B0\u5EFA\u539F\u751F\u4F1A\u8BDD\uFF0C\u53EA\u53D1\u9001\u65B0\u7684\u7528\u6237\u4EFB\u52A1\uFF1B\u65E7\u539F\u751F\u4F1A\u8BDD\u548C\u672C\u5730\u8C03\u7528\u8BB0\u5F55\u4FDD\u7559\u3002"
        };
      }
    });
    ready.commands.register({
      name: "google-acp-command",
      description: "\u5217\u51FA\u6216\u6267\u884C\u5B98\u65B9 ACP \u5DF2\u516C\u5E03\u7684\u539F\u751F\u547D\u4EE4",
      input: { hint: "\u547D\u4EE4\u540D [\u53C2\u6570]\uFF1B\u7559\u7A7A\u5217\u51FA\u53EF\u7528\u547D\u4EE4" },
      async handler({ agent, rawInput, signal }) {
        if (agent.model.current()?.provider !== ACP_PROVIDER)
          return { kind: "error", text: "\u8BF7\u5148\u9009\u62E9 Google \xB7 Antigravity ACP\u3002" };
        const state = projection.stateOf(agent.session);
        const commands = state.native?.commands;
        if (!rawInput.trim())
          return {
            kind: "success",
            text: commands?.length ? commands.map((c) => `${c.name} \u2014 ${c.description}`).join("\n") : "\u5B98\u65B9 ACP \u5C1A\u672A\u516C\u5E03\u547D\u4EE4\uFF0C\u8BF7\u5148\u5B8C\u6210\u4E00\u6B21\u5BF9\u8BDD\u3002"
          };
        const match = /^\s+\/?([a-z][a-z0-9_-]*)([\s\S]*)$/.exec(rawInput);
        if (!match || !commands?.some((c) => c.name === match[1]))
          return {
            kind: "error",
            text: "\u8BE5\u547D\u4EE4\u4E0D\u5728\u5B98\u65B9 ACP \u5F53\u524D\u516C\u5E03\u7684\u5217\u8868\u4E2D\u3002"
          };
        if (match[1] === "compact") {
          if (match[2].trim())
            return { kind: "error", text: "\u7528\u6CD5\uFF1A/compact\uFF08\u65E0\u53C2\u6570\uFF09" };
          try {
            return await adapter.compact(agent, signal);
          } catch (error) {
            return {
              kind: "error",
              text: error instanceof Error ? error.message : String(error)
            };
          }
        }
        if (!state.binding || state.binding.bad || state.binding.owner !== agent.id)
          return {
            kind: "error",
            text: "\u8BF7\u5148\u6062\u590D\u5B98\u65B9 ACP \u4F1A\u8BDD\u6216\u6267\u884C /google-acp-reset\u3002"
          };
        signal.throwIfAborted();
        agent.followup(
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: `/${match[1]}${match[2]}` }]
          })
        );
        return { kind: "success", text: "\u5DF2\u5C06\u539F\u751F\u547D\u4EE4\u52A0\u5165\u5F53\u524D\u4F1A\u8BDD\u3002" };
      }
    });
  });
}
export {
  ACP_PROMPT_POLICY,
  Config,
  GoogleAcpAdapter,
  apply,
  buildAcpPrompt,
  groupAcpModels,
  historyHash,
  inject,
  messagesAfterAnchor,
  name,
  resolveAcpModelSelection
};
//# sourceMappingURL=google-acp.js.map
