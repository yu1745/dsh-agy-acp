import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AcpConnection, AcpRpcError } from "./google-acp-rpc.js";
import {
  buildAcpElicitationResponse,
  isUserQuestionCancellation,
  parseAcpElicitation,
} from "./google-acp-elicitation.js";
import { acpTokenUsage } from "./google-acp-usage.js";
import { ACP_NOTICE, NativeSessionUpdates } from "./google-acp-session.js";
import {
  appendAcpRecord,
  type SessionRecordWriter,
} from "./google-acp-records.js";
import { DshMcpBridge, selectMcpTools } from "./google-acp-mcp.js";
import {
  acpReasoning,
  groupAcpModels,
  resolveAcpModelSelection,
  type AcpModelGroup,
} from "./google-acp-models.js";
export {
  groupAcpModels,
  resolveAcpModelSelection,
} from "./google-acp-models.js";
import {
  ACP_PROVIDER,
  ACP_BINDING,
  NativeToolRecorder,
  NativeMessageRecorder,
  acpProjection,
  type AcpState,
} from "./google-acp-state.js";

export const name = "yu-google-acp";
export const inject = ["llm", "agents", "tools", "sessionProjections"];
export const ACP_PROMPT_POLICY = "native-user-input-v1";
export const Config = z.object({
  command: z.string().default("agy"),
  args: z.array(z.string()).default(["acp"]),
  credentialStore: z.union([z.const("auto"), z.const("file")]).default("auto"),
  mcpTools: z.array(z.string()).default([]),
  requestTimeoutMs: z.number().min(1000).default(1800000),
});
type ConfigValue = {
  command: string;
  args: string[];
  credentialStore?: "auto" | "file";
  mcpTools: string[];
  requestTimeoutMs: number;
};

class AsyncQueue<T> {
  private items: T[] = [];
  private wake?: () => void;
  push(item: T) {
    this.items.push(item);
    this.wake?.();
    this.wake = undefined;
  }
  async next() {
    while (!this.items.length)
      await new Promise<void>((r) => {
        this.wake = r;
      });
    return this.items.shift()!;
  }
}

/** Whole ACP turns are opaque to DSH's model-step loop; native tools never become DSH tool-call blocks. */
export class GoogleAcpAdapter extends LlmAdapter {
  private connections = new Set<AcpConnection>();
  private active = new Set<string>();
  private live = new Map<string, {
    rpc: AcpConnection;
    cwd: string;
    sessionId: string;
    owner: object;
    init: any;
    session: any;
    bridge?: DshMcpBridge;
    recorders: Set<NativeToolRecorder>;
    release: (closing?: boolean) => void;
  }>();
  closeSession(agent: any) {
    const live = this.live.get(agent.id);
    if (live?.owner === agent) live.rpc.close();
  }
  private catalog: AcpModelGroup[] = [];
  private catalogSession: any;
  private catalogTask?: Promise<void>;
  private catalogKey?: string;
  private catalogConfigKey?: string;
  private catalogCredentialVersion?: string;
  private catalogRefreshAfter = 0;
  private catalogRevision = 0;
  private catalogRefreshAgain = false;
  private imagePrompts = false;
  private disposed = false;
  coordinates = new WeakMap<object, { turn: number; step: number }>();
  constructor(
    private ctx: any,
    public config: ConfigValue,
    private projection: { stateOf: (session: any) => AcpState },
    private writeRecord: SessionRecordWriter = appendAcpRecord,
  ) {
    super();
  }
  providerInfo(provider: string) {
    return { id: provider, name: "Google · Antigravity ACP" };
  }
  providerRetryPolicy() {
    return resolveRetryPolicy(
      { mode: "normal", maxRetries: 0 },
      "google-acp.retry",
    );
  }
  async listModels(provider: string) {
    this.refreshCatalog();
    return [
      {
        provider,
        id: "default",
        name: "Antigravity · 账号默认模型",
        inputModalities: this.inputModalities(),
      },
      ...this.catalog.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: this.inputModalities(),
      })),
    ];
  }
  async resolveModel(provider: string, model: string) {
    this.refreshCatalog();
    const group = this.catalog.find(
      (m) => m.id === model || m.nativeIds.has(model),
    );
    const reasoning = group
      ? acpReasoning(
          group,
          group.nativeIds.has(model) ? model : group.defaultNativeId,
        )
      : undefined;
    return {
      provider,
      id: model,
      name: group?.name ?? model,
      inputModalities: this.inputModalities(),
      ...(reasoning ? { reasoning } : {}),
      description:
        "官方 ACP 代理执行整轮任务；模型、上下文和原生工具由 Antigravity 管理。",
    };
  }
  /** Model enumeration never waits for filesystem, authentication or ACP RPC. */
  private inputModalities(): ("text" | "image")[] {
    return this.imagePrompts ? ["text", "image"] : ["text"];
  }
  private refreshCatalog() {
    if (this.disposed) return;
    const configKey = JSON.stringify([
      this.config.command,
      this.config.args,
      this.config.credentialStore ?? "auto",
    ]);
    if (configKey !== this.catalogConfigKey) {
      const hadConfig = this.catalogConfigKey !== undefined;
      const refreshing = this.catalogTask !== undefined;
      this.catalogConfigKey = configKey;
      this.catalogCredentialVersion = undefined;
      this.catalogRefreshAfter = 0;
      if (hadConfig) this.clearCatalog();
      if (refreshing) this.catalogRefreshAgain = true;
    }
    if (this.catalogTask) return;
    let revision = this.catalogRevision;
    this.catalogTask = Promise.resolve()
      .then(async () => {
        // Only file metadata is inspected; the official agent owns token contents.
        const version = await this.credentialVersion();
        if (
          this.disposed ||
          configKey !== this.catalogConfigKey ||
          revision !== this.catalogRevision
        )
          return;
        if (version !== this.catalogCredentialVersion) {
          if (this.catalogCredentialVersion !== undefined) {
            this.clearCatalog();
            this.catalogRefreshAfter = 0;
          }
          this.catalogCredentialVersion = version;
        }
        if (Date.now() < this.catalogRefreshAfter) return;
        this.catalogRefreshAfter = Date.now() + 30_000;
        revision = this.catalogRevision;
        await this.discover(revision);
      })
      .catch(() => {
        if (!this.disposed && revision === this.catalogRevision)
          this.clearCatalog();
      })
      .finally(() => {
        this.catalogTask = undefined;
        if (this.catalogRefreshAgain && !this.disposed) {
          this.catalogRefreshAgain = false;
          this.refreshCatalog();
        }
      });
  }
  private async credentialVersion() {
    if (this.config.credentialStore !== "file") return "auto";
    const flag = (...names: string[]) => {
      for (let i = 0; i < this.config.args.length; i++) {
        const arg = this.config.args[i];
        for (const name of names) {
          if (arg === name) return this.config.args[i + 1];
          if (arg.startsWith(name + "=")) return arg.slice(name.length + 1);
        }
      }
    };
    const gemini = resolve(
      homedir(),
      flag("--gemini-dir", "--gemini_dir") ?? ".gemini",
    );
    const app = resolve(
      gemini,
      flag("--app-data-dir", "--app_data_dir") ?? "antigravity-cli",
    );
    try {
      const info = await stat(join(app, "antigravity-oauth-token"));
      return JSON.stringify([
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ]);
    } catch (error: any) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }
  private connection(cwd: string) {
    if (this.disposed)
      throw new LlmError("Google ACP plugin is disposed.", "ACP_DISPOSED");
    const rpc = new AcpConnection(
      this.config.command,
      this.config.args,
      cwd,
      this.config.credentialStore,
    );
    this.connections.add(rpc);
    return rpc;
  }
  private async initialize(rpc: AcpConnection) {
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        session: { compaction: {}, notices: {} },
        ...(this.ctx.get("userQuestions") ? { elicitation: { form: {} } } : {}),
      },
      clientInfo: {
        name: "google-acp-extension",
        title: "Google ACP Extension",
        version: "0.1.0",
      },
    });
    if (
      init.protocolVersion !== 1 ||
      !/Antigravity/i.test(init.agentInfo?.name ?? "")
    )
      throw new LlmError(
        "Google ACP requires the unmodified official Antigravity ACP agent.",
        "ACP_AGENT",
      );
    if (!init.authMethods?.some((m: any) => m.id === "oauth-personal"))
      throw new LlmError(
        "Official ACP agent does not offer personal Google login. Run agy acp --login.",
        "AUTH",
      );
    await rpc.request("authenticate", { methodId: "oauth-personal" });
    this.imagePrompts =
      init.agentCapabilities?.promptCapabilities?.image === true;
    return init;
  }
  private async discover(revision = this.catalogRevision) {
    const cwd = await mkdtemp(join(tmpdir(), "google-acp-catalog-"));
    let rpc: AcpConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.disposed || revision !== this.catalogRevision) return;
      rpc = this.connection(cwd);
      timer = setTimeout(
        () => rpc?.close(new AcpRpcError("ACP catalog discovery timed out.")),
        15_000,
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
        await rpc
          .request("session/close", { sessionId: session.sessionId })
          .catch(() => {});
    } finally {
      clearTimeout(timer);
      rpc?.close();
      if (rpc) this.connections.delete(rpc);
      await rm(cwd, { recursive: true, force: true });
    }
  }
  private updateCatalog(session: any) {
    if (this.disposed) return;
    if (Array.isArray(session.models?.availableModels)) {
      this.catalogRevision++;
      this.catalogRefreshAfter = Date.now() + 30_000;
      const key = JSON.stringify([session.models, session.configOptions]);
      this.catalogSession = session;
      this.catalog = groupAcpModels(session);
      if (key !== this.catalogKey) {
        this.catalogKey = key;
        this.ctx.emit?.("llm/models-updated", ACP_PROVIDER);
      }
    }
  }
  private clearCatalog() {
    if (this.disposed) return;
    this.catalogRevision++;
    const changed = this.catalogSession !== undefined;
    this.catalog = [];
    this.catalogSession = undefined;
    this.catalogKey = undefined;
    if (changed) this.ctx.emit?.("llm/models-updated", ACP_PROVIDER);
  }
  private async preparePrompt(messages: any[], signal: AbortSignal) {
    const images = new Map<object, { data: string; mimeType: string }>();
    for (const message of messages) {
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        if (block.type !== "image") continue;
        if (!this.imagePrompts)
          throw new LlmError(
            "官方 ACP 当前未提供图片输入能力。",
            "ACP_MODALITY",
          );
        const attachments = this.ctx.get("attachments");
        if (!attachments || !block.attachment)
          throw new LlmError("图片附件不可用。", "ACP_MODALITY");
        const image = await attachments.readImage(block.attachment, signal);
        images.set(block, {
          data: Buffer.from(image.data).toString("base64"),
          mimeType: image.ref.mediaType,
        });
      }
    }
    return buildAcpPrompt(messages, images);
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== ACP_PROVIDER)
      throw new LlmError("Invalid Google ACP provider route.", "ACP_ROUTE");
    if (options.purpose)
      throw new LlmError(
        "Google ACP is an interactive agent backend; auxiliary model calls are disabled.",
        "ACP_PURPOSE",
      );
    const agent = options.sessionId
      ? this.ctx.agents.get(options.sessionId)
      : undefined;
    if (!agent)
      throw new LlmError(
        "Google ACP requires a live DSH session.",
        "ACP_SESSION",
      );
    if (this.active.has(agent.id))
      throw new LlmError(
        "An ACP turn is already running for this session.",
        "ACP_BUSY",
      );
    if (agent.session.header.origin === "subagent")
      throw new LlmError(
        "Consumer Google ACP access is reserved for interactive root sessions.",
        "ACP_INTERACTIVE_ONLY",
      );
    const previous = this.projection.stateOf(agent.session).binding;
    if (previous && (previous.owner !== agent.id || previous.bad))
      throw new LlmError(
        "Previous ACP turn has an uncertain outcome or belongs to a fork. Use /google-acp-reset or start a new session.",
        "ACP_RESUME",
      );
    if (previous && previous.promptPolicy !== ACP_PROMPT_POLICY)
      throw new LlmError(
        "This native session used an older context policy. Start a new conversation or run /google-acp-reset before sending a new task.",
        "ACP_CONTEXT_POLICY",
      );
    if (
      previous &&
      (previous.credentialStore ?? "auto") !==
        (this.config.credentialStore ?? "auto")
    )
      throw new LlmError(
        "The official credential store changed. Use /google-acp-reset or start a new conversation before continuing.",
        "ACP_AUTH_CONTEXT",
      );
    const pending = messagesAfterAnchor(
      options.messages,
      previous?.anchor,
      previous?.historyHash,
    ).filter((message) => {
      const delivered = previous?.steered?.find((m) => m.id === message.id);
      if (!delivered) return true;
      if (delivered.hash !== historyHash([message]))
        throw new LlmError(
          "A delivered steering message was edited; reset the native session.",
          "ACP_HISTORY",
        );
      return false;
    });
    if (!pending.length && previous?.steered?.length) {
      this.writeRecord(agent.session, ACP_BINDING, {
        ...previous,
        anchor: options.messages.at(-1)?.id ?? previous.anchor,
        historyHash: historyHash(options.messages),
        steered: [],
      });
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (!pending.length)
      throw new LlmError(
        "No new messages to send to the official ACP agent.",
        "ACP_EMPTY",
      );
    const anchor = options.messages.findLast(isUserTask)?.id ?? null;
    if (!anchor)
      throw new LlmError(
        "ACP session messages require durable identities.",
        "ACP_SESSION",
      );
    this.active.add(agent.id);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let rpc: AcpConnection | undefined;
    let bridge: DshMcpBridge | undefined;
    let recorder: NativeToolRecorder | undefined;
    let messageRecorder: NativeMessageRecorder | undefined;
    let toolSet: any;
    let nativeSessionId: string | undefined;
    let accepted = false;
    let retainConnection = false;
    let stopSteering: (() => void) | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (!rpc) return;
      if (nativeSessionId)
        rpc.notify("session/cancel", { sessionId: nativeSessionId });
      // Let the official agent settle cancellation before killing its process tree.
      cancelTimer ??= setTimeout(
        () => rpc?.close(new LlmError("ACP turn cancelled.", "ABORTED")),
        2500,
      );
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      controller.signal.throwIfAborted();
      const cwd = agent.session.header.cwd;
      if (!cwd)
        throw new LlmError(
          "Select a workspace before using Google ACP.",
          "ACP_WORKSPACE",
        );
      let live = this.live.get(agent.id);
      if (live && (live.sessionId !== previous?.nativeSessionId || live.cwd !== cwd || live.owner !== agent)) {
        live.rpc.close();
        live = undefined;
      }
      rpc = live?.rpc ?? this.connection(cwd);
      const recorders = live?.recorders ?? new Set<NativeToolRecorder>();
      let nativeConfig: any;
      const nativeUpdates = new NativeSessionUpdates(
        (type, data) => this.writeRecord(agent.session, type, data),
        (update) => {
          if (Array.isArray(update.configOptions)) {
            nativeConfig = update.configOptions;
            this.updateCatalog({ ...session, configOptions: nativeConfig });
          }
        },
      );
      if (!live) rpc.onNotification = (method, params) => {
        if (method === "session/update") nativeUpdates.receive(params);
      };
      const init = live?.init ?? await this.initialize(rpc);
      controller.signal.throwIfAborted();
      const prompt = await this.preparePrompt(pending, controller.signal);
      const invokedSkills = new Set(options.messages.flatMap((message) => {
        const source = message.role === "user" ? message.source as { kind?: string; name?: string } | undefined : undefined;
        return source?.kind === "skill-invocation" && source.name ? [source.name] : [];
      }));
      const skills = this.ctx.get("skills");
      if (skills && invokedSkills.size) {
        for (const block of prompt) {
          if (block.type !== "text") continue;
          const name = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(block.text)?.[1];
          if (!name || !invokedSkills.has(name)) continue;
          const skill = await skills.get(name, { cwd, scope: agent, signal: controller.signal });
          controller.signal.throwIfAborted();
          const base = skill?.resourceBase;
          if (!skill?.invocation.userInvocable || base?.kind !== "directory" || !isAbsolute(base.path)) continue;
          const path = join(base.path, "SKILL.md");
          if (!(await stat(path).catch(() => undefined))?.isFile()) continue;
          block.text = `Read the DSH skill instructions at ${JSON.stringify(path)} and follow them for this invocation.\n\n${block.text}`;
        }
      }
      if (!prompt.length)
        throw new LlmError(
          "No user task to send to the official ACP agent.",
          "ACP_EMPTY",
        );
      const boundary = this.ctx.agents.turnBoundaryOf(agent.session);
      const turn = boundary.lastTurn;
      const step = this.coordinates.get(agent)?.step ?? 1;
      let schemas: any[] = [];
      if (this.config.mcpTools.length) {
        toolSet = await this.ctx.tools.resolve({
          agent,
          modelSelection: { provider: options.provider, model: options.model },
          signal: controller.signal,
        });
        schemas = selectMcpTools(
          this.ctx.tools.schemas(agent, toolSet),
          this.config.mcpTools,
        );
      }
      if (schemas.length) {
        const invoke = async (name: string, args: any) => {
          controller.signal.throwIfAborted();
          const id = `extension-${randomUUID()}`;
          try {
            const batch = await this.ctx.tools.execute({
              calls: [
                {
                  type: "tool-call",
                  id,
                  name,
                  arguments: JSON.stringify(args),
                },
              ],
              signal: controller.signal,
              agent,
              toolSet,
            });
            const result = batch.results[0]?.result;
            if (!result) throw Error("DSH executor returned no tool result");
            const content = await Promise.all(
              result.content.map(async (b: any) => {
                if (b.type === "text") return { type: "text", text: b.text };
                if (b.type === "image" && b.attachment) {
                  const attachments = this.ctx.get("attachments");
                  if (!attachments)
                    throw new Error("Image content is unavailable.");
                  const image = await attachments.readImage(
                    b.attachment,
                    controller.signal,
                  );
                  return {
                    type: "image",
                    data: Buffer.from(image.data).toString("base64"),
                    mimeType: image.ref.mediaType,
                  };
                }
                return { type: "text", text: JSON.stringify(b) };
              }),
            );
            if (batch.concluded)
              content.push({
                type: "text",
                text: "This tool requests that this turn now conclude. Return your final response without further tools.",
              });
            return { content, isError: result.isError };
          } catch (e) {
            throw e;
          }
        };
        bridge = live?.bridge;
        if (bridge) {
          if (JSON.stringify(bridge.tools) !== JSON.stringify(schemas))
            throw new LlmError("DSH tool configuration changed for the live ACP session.", "ACP_TOOLS_CHANGED");
          bridge.setInvoker(invoke);
        } else if (!live) {
          bridge = new DshMcpBridge(schemas, invoke);
          await bridge.start();
        }
      }
      bridge ??= live?.bridge;
      const fields = {
        cwd,
        mcpServers: bridge ? [bridge.descriptor()] : [],
      };
      if (previous && !init.agentCapabilities?.sessionCapabilities?.resume)
        throw new LlmError(
          "Official ACP agent cannot resume sessions; refusing to replay the task.",
          "ACP_RESUME",
        );
      const session = live?.session ?? await rpc.request(
        previous ? "session/resume" : "session/new",
        {
          ...fields,
          ...(previous ? { sessionId: previous.nativeSessionId } : {}),
        },
      );
      nativeSessionId = previous?.nativeSessionId ?? session.sessionId;
      if (typeof nativeSessionId !== "string" || !nativeSessionId)
        throw new LlmError(
          "Invalid native ACP session identity.",
          "ACP_SESSION",
        );
      nativeUpdates.bind(nativeSessionId);
      recorder = new NativeToolRecorder(
        agent.session,
        nativeSessionId,
        turn,
        (type, data) => this.writeRecord(agent.session, type, data),
        step,
      );
      messageRecorder = new NativeMessageRecorder(
        agent.session,
        nativeSessionId,
        turn,
        step,
        (type, data) => this.writeRecord(agent.session, type, data),
      );
      this.updateCatalog({
        ...session,
        ...(nativeConfig ? { configOptions: nativeConfig } : {}),
      });
      const nativeModel = resolveAcpModelSelection(
        Array.isArray(session.models?.availableModels)
          ? session
          : (this.catalogSession ?? session),
        options.model,
        options.reasoningEffort,
      );
      const queue = new AsyncQueue<any>();
      let detached = false;
      let segmentTimer: ReturnType<typeof setTimeout> | undefined;
      const receiveTool = (update: any, origin?: "Antigravity" | "DSH · MCP") => {
        const owner = [...recorders].find((candidate) => candidate.has(update.toolCallId)) ?? recorder!;
        if (owner === recorder) messageRecorder!.tool(update.toolCallId);
        return owner.update(update, origin);
      };
      const release = (closing = false) => {
        clearTimeout(segmentTimer);
        controller.abort();
        if (detached) {
          messageRecorder!.finish(closing ? "interrupted" : "settled");
          if (closing) for (const recorder of recorders) recorder.finish("incomplete");
        }
      };
      live?.release();
      for (const old of recorders) if (!old.hasOpenCalls()) recorders.delete(old);
      recorders.add(recorder);
      const transport = { rpc, cwd, sessionId: nativeSessionId, owner: agent, init, session, bridge, recorders, release };
      this.live.set(agent.id, transport);
      rpc.onClose = () => {
        this.connections.delete(transport.rpc);
        if (this.live.get(agent.id) === transport) this.live.delete(agent.id);
        if (detached) {
          try {
            release(true);
          } catch (error) {
            // Agent disposal can detach the session record sink before this callback.
            this.ctx.logger?.warn?.("Failed to finalize ACP records: %s", error);
          } finally {
            void bridge?.close().catch(() => {});
          }
        }
      };
      let blockedPermission: { code: string; message: string } | undefined;
      const isLiveOwner = () => {
        const sessions = this.ctx.get("sessions");
        return this.live.get(agent.id) === transport && this.ctx.agents.get(agent.id) === agent &&
          (!sessions?.get || sessions.get(agent.session.id) === agent.session);
      };
      rpc.onNotification = (method, params) => {
        if (
          (detached && !isLiveOwner()) ||
          method !== "session/update" ||
          params?.sessionId !== nativeSessionId
        )
          return;
        const u = params.update;
        nativeUpdates.receive(params);
        if (detached && u?.sessionUpdate === "usage_update") {
          clearTimeout(segmentTimer);
          messageRecorder!.finish();
        }
        if (u?.sessionUpdate === "notice" && typeof u.title === "string")
          this.writeRecord(agent.session, ACP_NOTICE, {
            nativeSessionId,
            turn,
            step,
            id: randomUUID(),
            title: u.title.slice(0, 1024),
            description:
              typeof u.description === "string"
                ? u.description.slice(0, 4096)
                : "",
            severity:
              typeof u.severity === "string" ? u.severity.slice(0, 64) : "info",
          });
        if (u?.sessionUpdate === "plan" && Array.isArray(u.entries)) {
          const todos = u.entries.slice(0, 256).flatMap((entry: any) =>
            typeof entry?.content === "string" &&
            ["pending", "in_progress", "completed"].includes(entry.status)
              ? [
                  {
                    content: entry.content.slice(0, 4096),
                    status: entry.status,
                  },
                ]
              : [],
          );
          // A log-only whole-list snapshot uses the host's existing Todo UI.
          agent.session.append("todo/write", { todos });
        }
        const compaction = nativeUpdates.compaction(u);
        if (compaction) {
          messageRecorder!.tool(compaction.toolCallId);
          recorder!.update(compaction);
        }
        if (
          u?.sessionUpdate === "tool_call" ||
          u?.sessionUpdate === "tool_call_update"
        ) {
          const info = JSON.stringify([u.title, u._meta, u.rawInput]);
          const origin =
            info.includes("google-acp-extensions") ||
            schemas.some((t) => info.includes(t.mcpName))
              ? "DSH · MCP"
              : "Antigravity";
          try {
            receiveTool(u, origin);
          } catch (error) {
            if (detached) rpc?.close();
            else {
              queue.push({ type: "error", error });
              cancel();
            }
          }
        } else if (
          ["agent_message_chunk", "agent_thought_chunk"].includes(
            u?.sessionUpdate,
          ) &&
          u.content?.type === "text"
        ) {
          messageRecorder!.delta(
            u.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text",
            u.content.text,
          );
          if (detached) {
            clearTimeout(segmentTimer);
            segmentTimer = setTimeout(() => {
              if (!isLiveOwner()) return;
              try {
                messageRecorder!.finish();
              } catch {
                rpc?.close();
              }
            }, 120_000);
            segmentTimer.unref();
            return;
          }
          queue.push({
            type: "delta",
            kind:
              u.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text",
            text: u.content.text,
          });
        }
      };
      rpc.onRequest = async (method, params) => {
        if (detached && !isLiveOwner()) throw new AcpRpcError("ACP session owner is unavailable", -32601);
        if (method === "elicitation/create" && params?.sessionId === nativeSessionId) {
          const plan = parseAcpElicitation(params);
          const service = this.ctx.get("userQuestions");
          if (!plan || !service || controller.signal.aborted)
            return { action: "cancel" };
          const toolCallId = params.toolCallId;
          const track = (status: string) => {
            if (typeof toolCallId === "string" && toolCallId) {
              receiveTool({ toolCallId, status });
            }
          };
          track("waiting_input");
          try {
            const answer = await service.ask({
              agent,
              signal: controller.signal,
              questions: plan.questions,
            });
            const result = controller.signal.aborted
              ? { action: "cancel" }
              : buildAcpElicitationResponse(plan, answer);
            track(result.action === "accept" ? "in_progress" : "cancelled");
            return result;
          } catch (error) {
            if (controller.signal.aborted || isUserQuestionCancellation(error)) {
              track("cancelled");
              return { action: "cancel" };
            }
            track("failed");
            throw error;
          }
        }
        if (
          method !== "session/request_permission" ||
          params?.sessionId !== nativeSessionId
        )
          throw new AcpRpcError("Unsupported ACP client request", -32601);
        const call = params.toolCall ?? {};
        if (call.toolCallId?.startsWith("interaction_")) {
          receiveTool({ ...call, status: "waiting_input" });
          const service = this.ctx.get("userQuestions");
          if (!service || !params.options?.length)
            return { outcome: { outcome: "cancelled" } };
          const labels = params.options.map(
            (o: any, i: number) => `${i + 1}. ${o.name ?? o.optionId}`,
          );
          const answer = await service.ask({
            agent,
            signal: controller.signal,
            questions: [
              {
                id: call.toolCallId,
                header: "Antigravity",
                question: call.title ?? "请选择",
                options: labels.map((label: string) => ({ label })),
                multiSelect: false,
              },
            ],
          });
          const choice = answer.answers?.find(
            (a: any) => a.id === call.toolCallId,
          );
          const index =
            choice?.selected?.length === 1 && !choice.custom
              ? labels.indexOf(choice.selected[0])
              : -1;
          receiveTool({
            ...call,
            status: index >= 0 ? "completed" : "cancelled",
          });
          return index >= 0
            ? {
                outcome: {
                  outcome: "selected",
                  optionId: params.options[index].optionId,
                },
              }
            : { outcome: { outcome: "cancelled" } };
        }
        receiveTool({ ...call, status: "waiting_approval" });
        const allow = params.options?.find((o: any) => o.kind === "allow_once");
        const reject = params.options?.find(
          (o: any) => o.kind === "reject_once",
        );
        const preset = fullAccessPreset(this.ctx, agent.session);
        const outcome = controller.signal.aborted
          ? "cancelled"
          : allow && preset
            ? "allowed-once"
            : !detached && allow && this.ctx.get("approval")
              ? await this.ctx.get("approval").request({
                  agent,
                  toolName: call.title ?? "Antigravity tool",
                  reason: JSON.stringify({
                    title: call.title ?? "ACP permission",
                    input: call.rawInput ?? null,
                    locations: call.locations ?? [],
                  }),
                  signal: controller.signal,
                })
              : "unavailable";
        const message =
          outcome === "allowed-once"
            ? preset
              ? "已按当前会话的完整访问权限允许本次调用。"
              : "已审批允许本次调用。"
            : outcome === "rejected"
              ? "此调用的审批被拒绝，操作未获执行许可。"
              : outcome === "cancelled"
                ? "本次审批已取消，操作未获执行许可。"
                : detached
                  ? "后台唤醒发起了新的权限请求，DSH 需要在打开的回合内审批。操作未获执行许可。"
                  : "本次调用没有可用的单次审批授权，操作未获执行许可。";
        if (outcome !== "allowed-once")
          blockedPermission = {
            code: "ACP_PERMISSION_DENIED",
            message: `${message} 官方代理也未返回最终答复，请检查会话权限后重新发送任务。`,
          };
        const selected = outcome === "allowed-once" ? allow : reject;
        receiveTool({
          ...call,
          status: outcome === "allowed-once" ? "in_progress" : "failed",
          permission: {
            outcome: ["allowed-once", "rejected", "cancelled"].includes(outcome)
              ? outcome
              : "unavailable",
            source: preset && allow ? "session-preset" : "approval-service",
            ...(preset && allow ? { preset } : {}),
            message,
          },
        });
        return selected
          ? { outcome: { outcome: "selected", optionId: selected.optionId } }
          : { outcome: { outcome: "cancelled" } };
      };
      if (nativeModel) {
        await rpc.request("session/set_model", {
          sessionId: nativeSessionId,
          modelId: nativeModel,
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
          (entry) =>
            !options.messages.some((message) => message.id === entry.id),
        ),
      };
      this.writeRecord(agent.session, ACP_BINDING, binding);
      accepted = true;
      const task = rpc.request(
        "session/prompt",
        { sessionId: nativeSessionId, prompt },
        this.config.requestTimeoutMs,
      );
      const steering = new Set<Promise<any>>();
      let submissions = Promise.resolve();
      const sendSteering = ({ agent: owner, message }: any) => {
        if (
          owner?.id !== agent.id ||
          controller.signal.aborted ||
          !isUserTask(message) ||
          !agent.inbox?.nextStep.some((m: any) => m.id === message.id) ||
          binding.steered.some((m) => m.id === message.id)
        )
          return;
        const entry = { id: message.id, hash: historyHash([message]) };
        try {
          this.writeRecord(agent.session, ACP_BINDING, {
            ...binding,
            steered: [...binding.steered, entry],
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
          const completion = rpc!.request(
            "session/prompt",
            { sessionId: nativeSessionId, prompt: extra },
            this.config.requestTimeoutMs,
          );
          // Track the request before recording presentation state.
          void completion.catch(() => {});
          messageRecorder!.finish();
          this.writeRecord(agent.session, ACP_NOTICE, {
            nativeSessionId,
            turn,
            step,
            id: `steer:${message.id}`,
            title: "插话已提交至 ACP",
            description: "已沿当前连接发送；由原生代理在执行边界接收。",
            severity: "info",
          });
          return { completion };
        });
        submissions = submitted.then(
          () => {},
          () => {},
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
          ({ agent: owner, message }: any) => {
            if (
              owner?.id !== agent.id ||
              controller.signal.aborted ||
              !binding.steered.some((m) => m.id === message.id)
            )
              return;
            queue.push({
              type: "error",
              error: new LlmError(
                "已提交给 ACP 的插话被修改或移除，无法撤回原生上下文。请新建会话或执行 /google-acp-reset。",
                "ACP_HISTORY",
              ),
            });
            cancel();
          },
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
            stopSteering = undefined;
            if (result?.stopReason === "end_turn" && recorder?.hasActiveBackgroundCalls() && !controller.signal.aborted) {
              await new Promise<void>((resolve, reject) => {
                const connection = rpc!;
                const onNotification = connection.onNotification;
                const previousClose = connection.onClose;
                let quiet: ReturnType<typeof setTimeout> | undefined;
                let wakeReply = false;
                const cleanup = () => {
                  clearTimeout(deadline);
                  clearTimeout(quiet);
                  connection.onNotification = onNotification;
                  connection.onClose = previousClose;
                  controller.signal.removeEventListener("abort", finish);
                };
                const finish = () => {
                  cleanup();
                  resolve();
                };
                // Keep the foreground turn bounded. The session listener stays
                // attached after this wait, including when the tool is still running.
                const deadline = setTimeout(finish, this.config.requestTimeoutMs);
                connection.onClose = (error) => {
                  cleanup();
                  reject(error);
                  previousClose(error);
                };
                controller.signal.addEventListener("abort", finish, { once: true });
                connection.onNotification = (method, params) => {
                  onNotification(method, params);
                  if (method !== "session/update" || params?.sessionId !== nativeSessionId) return;
                  const update = params.update?.sessionUpdate;
                  if (update === "agent_message_chunk" && !recorder?.hasActiveBackgroundCalls()) wakeReply = true;
                  if (update === "usage_update" && wakeReply && !recorder?.hasActiveBackgroundCalls()) {
                    finish();
                    return;
                  }
                  if (!["tool_call", "tool_call_update", "agent_message_chunk", "agent_thought_chunk"].includes(update)) return;
                  clearTimeout(quiet);
                  // agy usually reports usage after its wake reply. With no
                  // usage signal, release the foreground after a quiet period.
                  if (!recorder?.hasActiveBackgroundCalls()) quiet = setTimeout(finish, 15_000);
                };
              });
            }
            queue.push({ type: "done", result });
          } catch (error) {
            queue.push({ type: "error", error });
          }
        },
        (error) => queue.push({ type: "error", error }),
      );
      let index = -1;
      let current: { type: "text" | "reasoning"; text: string } | undefined;
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
          current!.text += item.text;
          if (item.kind === "text") visibleText += item.text;
          yield item.kind === "text"
            ? { type: "text-delta", index, text: item.text }
            : { type: "reasoning-delta", index, text: item.text };
          continue;
        }
        if (current) yield { type: "block-end", index, block: current };
        if (item.type === "error") throw item.error;
        const stop = item.result?.stopReason;
        messageRecorder.finish(
          stop === "cancelled" || controller.signal.aborted
            ? "interrupted"
            : "settled",
        );
        this.writeRecord(agent.session, ACP_BINDING, {
          ...binding,
          bad: false,
        });
        accepted = false;
        const usage =
          steering.size === 0 ? acpTokenUsage(item.result?.usage) : undefined;
        if (usage) yield { type: "usage", usage };
        if (
          /service has been disabled in this account|account (?:has been |is )?(?:suspended|disabled)/i.test(
            visibleText,
          )
        )
          throw new LlmError(
            "Google reports that this account's Antigravity service is disabled. Follow the official appeal process; the plugin will not retry or switch authentication.",
            "ACCOUNT_DISABLED",
          );
        if (stop === "cancelled" || controller.signal.aborted) {
          recorder.finish("cancelled");
          yield {
            type: "finish",
            reason: {
              kind: "aborted",
              failure: {
                code: "ABORTED",
                message: "Official ACP turn cancelled.",
              },
            },
          };
        } else if (stop === "end_turn") {
          if (!visibleText.trim() && (blockedPermission || !recorder.hasOpenCalls()))
            throw new LlmError(
              blockedPermission?.message ??
                "官方 ACP 代理结束了回合，但没有返回最终答复。请检查调用记录后重新发送任务。",
              blockedPermission?.code ?? "ACP_EMPTY_REPLY",
            );
          detached = true;
          retainConnection = this.live.get(agent.id) === transport;
          if (retainConnection) recorder.preserveAfterTurn();
          else recorder.finish("incomplete");
          yield { type: "finish", reason: { kind: "stop" } };
        } else if (stop === "max_tokens") {
          recorder.finish("incomplete");
          yield { type: "finish", reason: { kind: "max-tokens" } };
        } else
          throw new LlmError(
            `Official ACP agent stopped: ${stop ?? "missing stopReason"}`,
            "ACP_STOP",
          );
        break;
      }
    } catch (error) {
      messageRecorder?.finish("interrupted");
      recorder?.finish(controller.signal.aborted ? "cancelled" : "failed");
      if (error instanceof AcpRpcError && error.code === -32000)
        throw new LlmError(
          "Google sign-in required. Run agy acp --login with your subscription account.",
          "AUTH",
        );
      throw error;
    } finally {
      stopSteering?.();
      messageRecorder?.finish("interrupted");
      // Early iterator return cancels the whole native turn, including its tools.
      if (accepted && !controller.signal.aborted) controller.abort();
      controller.signal.removeEventListener("abort", cancel);
      clearTimeout(cancelTimer);
      options.signal?.removeEventListener("abort", abort);
      if (retainConnection) {
        bridge?.setInvoker(async () => {
          throw new Error("DSH extension tools require an active DSH turn.");
        });
      } else {
        controller.abort();
        rpc?.close();
        if (rpc) this.connections.delete(rpc);
        await bridge?.close();
      }
      toolSet?.dispose();
      this.active.delete(agent.id);
    }
  }
  isBusy(agent: any) {
    return this.active.has(agent.id);
  }
  async compact(agent: any, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active.has(agent.id))
      throw new Error("请先停止当前 ACP 任务，再压缩上下文。");
    const binding = this.projection.stateOf(agent.session).binding;
    if (!binding)
      return { kind: "success", text: "尚未建立官方 ACP 上下文，无需压缩。" };
    if (
      binding.owner !== agent.id ||
      binding.bad ||
      binding.promptPolicy !== ACP_PROMPT_POLICY ||
      (binding.credentialStore ?? "auto") !==
        (this.config.credentialStore ?? "auto")
    )
      throw new Error(
        "原生 ACP 会话状态或认证配置已变化，请先新建会话或执行 /google-acp-reset。",
      );
    return agent.runMaintenance(async (maintenanceSignal: AbortSignal) => {
      const abort = AbortSignal.any([signal, maintenanceSignal]);
      abort.throwIfAborted();
      this.active.add(agent.id);
      let rpc: AcpConnection | undefined;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const live = this.live.get(agent.id);
      const reuse = live?.owner === agent && live.sessionId === binding.nativeSessionId ? live : undefined;
      let restore: (() => void) | undefined;
      const cancel = () => {
        rpc?.notify("session/cancel", { sessionId: binding.nativeSessionId });
        cancelTimer ??= setTimeout(
          () => rpc?.close(new Error("ACP compaction cancelled")),
          2500,
        );
      };
      abort.addEventListener("abort", cancel, { once: true });
      try {
        const cwd = agent.session.header.cwd;
        if (!cwd) throw new Error("请先选择工作区。");
        rpc = reuse?.rpc ?? this.connection(cwd);
        const updates = new NativeSessionUpdates((type, data) =>
          this.writeRecord(agent.session, type, data),
        );
        const turn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn;
        const recorder = new NativeToolRecorder(
          agent.session,
          binding.nativeSessionId,
          turn,
          (type, data) => this.writeRecord(agent.session, type, data),
        );
        let response = "";
        const notify = rpc.onNotification;
        const request = rpc.onRequest;
        restore = () => {
          rpc!.onNotification = notify;
          rpc!.onRequest = request;
        };
        rpc.onNotification = (method, params) => {
          if (method !== "session/update") return;
          updates.receive(params);
          if (params?.sessionId !== updates.id) return;
          const u = params.update;
          const compaction = updates.compaction(u);
          if (compaction) recorder.update(compaction);
          else if (reuse && !["agent_message_chunk", "usage_update", "available_commands_update"].includes(u?.sessionUpdate)) notify(method, params);
          if (
            u?.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text"
          )
            response = (response + u.content.text).slice(0, 64 * 1024);
        };
        // Compression needs no tool execution. Unexpected permission requests fail closed.
        rpc.onRequest = async () => ({ outcome: { outcome: "cancelled" } });
        if (reuse) {
          updates.commands = this.projection.stateOf(agent.session).native?.commands ?? null;
        } else {
          const init = await this.initialize(rpc);
          abort.throwIfAborted();
          if (!init.agentCapabilities?.sessionCapabilities?.resume)
            throw new Error("官方 ACP 不支持恢复会话，未发送压缩请求。");
          await rpc.request("session/resume", {
            cwd,
            mcpServers: [],
            sessionId: binding.nativeSessionId,
          });
        }
        updates.bind(binding.nativeSessionId);
        await updates.requireCommand("compact", abort);
        abort.throwIfAborted();
        this.writeRecord(agent.session, ACP_BINDING, { ...binding, bad: true });
        started = true;
        const result = await rpc.request(
          "session/prompt",
          {
            sessionId: binding.nativeSessionId,
            prompt: [{ type: "text", text: "/compact" }],
          },
          this.config.requestTimeoutMs,
        );
        // A settled native command preserves the conversation anchor: no host task was sent.
        this.writeRecord(agent.session, ACP_BINDING, {
          ...binding,
          bad: false,
        });
        started = false;
        abort.throwIfAborted();
        if (result?.stopReason !== "end_turn")
          throw new Error(
            `官方 ACP 压缩未完成：${result?.stopReason ?? "missing stopReason"}`,
          );
        const failure = updates.compactionFailure();
        if (failure) throw new Error(failure);
        await this.ctx.get("sessions")?.flush(agent.session);
        return {
          kind: "success",
          text:
            response.trim() ||
            "官方 ACP 已处理 /compact；占用以最新上报为准，本地记录保留。",
        };
      } finally {
        if (started) cancel();
        abort.removeEventListener("abort", cancel);
        clearTimeout(cancelTimer);
        if (reuse && !started && !abort.aborted) restore?.();
        else {
          rpc?.close();
          if (rpc) this.connections.delete(rpc);
        }
        this.active.delete(agent.id);
      }
    });
  }
  dispose() {
    this.disposed = true;
    for (const rpc of this.connections) rpc.close();
    this.connections.clear();
  }
}

/** A full-access preset is an existing user grant, not a request to escalate.
 * Auto and custom states never qualify for this shortcut. Resolve both knobs
 * so a reused preset name cannot accidentally turn restricted access into a grant.
 */
function fullAccessPreset(ctx: any, session: any): string | undefined {
  const service = ctx.get("permissionPresets");
  if (!service) return;
  try {
    const preset = service.current(session);
    if (!preset || preset === "auto" || preset === "custom") return;
    const spec = service.resolve(preset);
    if (spec.sandbox === "danger-full-access" && spec.approval === "never")
      return preset;
  } catch {
    // An unavailable permission service never creates an implicit grant.
  }
}

/** Only new messages enter resumed native sessions. Never replay an edited/forked history silently. */
export function historyHash(messages: any[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        messages
          .filter(isUserTask)
          .map((m) => [m.role, m.id ?? null, m.content]),
      ),
    )
    .digest("hex");
}
export function messagesAfterAnchor(
  messages: any[],
  anchor?: string | null,
  expectedHash?: string,
) {
  let start = 0;
  if (anchor) {
    const index = messages.findIndex((m) => m.id === anchor);
    if (index < 0)
      throw new LlmError(
        "DSH history no longer matches the ACP session. Use /google-acp-reset or start a new session.",
        "ACP_HISTORY",
      );
    if (
      expectedHash &&
      historyHash(messages.slice(0, index + 1)) !== expectedHash
    )
      throw new LlmError(
        "DSH history was edited after submission to ACP. Use /google-acp-reset or start a new session.",
        "ACP_HISTORY",
      );
    start = index + 1;
  }
  const tasks = messages.slice(start).filter(isUserTask);
  // Fresh native sessions start from the current user task, without replaying
  // historical commands or importing automatically generated host context.
  return anchor ? tasks : tasks.slice(-1);
}
function isUserTask(message: any) {
  return (
    message.role === "user" &&
    (message.source === undefined || message.source?.kind === "user")
  );
}
export function buildAcpPrompt(
  messages: any[],
  images?: Map<object, { data: string; mimeType: string }>,
) {
  const prompt: any[] = [];
  for (const m of messages.filter(isUserTask)) {
    const content =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content;
    for (const b of content ?? []) {
      if (b.type === "image") {
        const image = images?.get(b);
        if (image) {
          prompt.push({ type: "image", ...image });
          continue;
        }
        throw new LlmError(
          "Image input requires an admitted attachment and native ACP image capability; text only otherwise.",
          "ACP_MODALITY",
        );
      }
      if (b.type === "text")
        prompt.push({
          type: "text",
          text: b.text,
        });
      else if (b.type !== "reasoning")
        throw new LlmError(
          "This ACP bridge currently supports user text only.",
          "ACP_MODALITY",
        );
    }
  }
  return prompt;
}
export async function apply(ctx: any, config: ConfigValue) {
  // Launch only ACP. Reject headless flags and permission-bypass switches.
  if (
    config.args[0] !== "acp" ||
    config.args.some((s) =>
      /^(?:-p|--prompt|--dangerously-skip-permissions|--override_user_agent_name|--cloud_code_endpoint|--worker)(?:=|$)/.test(
        s,
      ),
    )
  )
    throw new Error(
      "Google subscription access requires the official agy acp runtime and its normal permissions.",
    );
  const projection = await ctx.sessionProjections.register(
    acpProjection as any,
  );
  const adapter = new GoogleAcpAdapter(ctx, config, projection);
  ctx.reflect.provide("yuGoogleAcp", adapter);
  ctx.llm.registerAdapter([ACP_PROVIDER], adapter);
  ctx.on("agent/request", async (payload: any, next: () => any) => {
    adapter.coordinates.set(payload.agent, {
      turn: payload.turn,
      step: payload.step,
    });
    return next();
  });
  ctx.on("agent/disposed", ({ agent }: any) => adapter.closeSession(agent));
  ctx.on("dispose", () => adapter.dispose());
  ctx.on("dispose", () => projection.dispose());
  ctx.inject(["commands"], (ready: any) => {
    ready.commands.register({
      name: "google-acp-reset",
      description: "新建官方 ACP 上下文，保留 DSH 对话和调用记录",
      handler({ agent }: any) {
        if (agent.status !== "idle" || adapter.isBusy(agent))
          return {
            kind: "error",
            text: "请先停止当前任务，再重置 ACP 上下文。",
          };
        adapter.closeSession(agent);
        appendAcpRecord(agent.session, ACP_BINDING, { reset: true });
        return {
          kind: "success",
          text: "下次 Google ACP 回复将新建原生会话，只发送新的用户任务；旧原生会话和本地调用记录保留。",
        };
      },
    });
    ready.commands.register({
      name: "google-acp-command",
      description: "列出或执行官方 ACP 已公布的原生命令",
      input: { hint: "命令名 [参数]；留空列出可用命令" },
      async handler({ agent, rawInput, signal }: any) {
        if (agent.model.current()?.provider !== ACP_PROVIDER)
          return { kind: "error", text: "请先选择 Google · Antigravity ACP。" };
        const state = projection.stateOf(agent.session);
        const commands = state.native?.commands;
        if (!rawInput.trim())
          return {
            kind: "success",
            text: commands?.length
              ? commands
                  .map((c: any) => `${c.name} — ${c.description}`)
                  .join("\n")
              : "官方 ACP 尚未公布命令，请先完成一次对话。",
          };
        const match = /^\s+\/?([a-z][a-z0-9_-]*)([\s\S]*)$/.exec(rawInput);
        if (!match || !commands?.some((c: any) => c.name === match[1]))
          return {
            kind: "error",
            text: "该命令不在官方 ACP 当前公布的列表中。",
          };
        if (match[1] === "compact") {
          if (match[2].trim())
            return { kind: "error", text: "用法：/compact（无参数）" };
          try {
            return await adapter.compact(agent, signal);
          } catch (error) {
            return {
              kind: "error",
              text: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (
          !state.binding ||
          state.binding.bad ||
          state.binding.owner !== agent.id
        )
          return {
            kind: "error",
            text: "请先恢复官方 ACP 会话或执行 /google-acp-reset。",
          };
        signal.throwIfAborted();
        agent.followup(
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: `/${match[1]}${match[2]}` }],
          }),
        );
        return { kind: "success", text: "已将原生命令加入当前会话。" };
      },
    });
  });
}
