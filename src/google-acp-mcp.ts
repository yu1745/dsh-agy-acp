import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Only these explicitly selected extension tools cross into the native agent. */
export function selectMcpTools(schemas: any[], allow: readonly string[]) {
  const nativeDuplicates =
    /^(?:bash|sh|shell|pwsh|terminal|read|write|edit|apply_patch|grep|glob|ls|read_file|write_file|edit_file|view_file|run_command|replace_file_content|find_by_name|grep_search|list_dir|todo_write|update_plan|subagent|spawn_agent|fork_agent)$/i;
  if (new Set(allow).size !== allow.length)
    throw new Error("Duplicate Google ACP MCP tool selection.");
  return allow.map((name, i) => {
    if (nativeDuplicates.test(name))
      throw new Error(
        `DSH tool ${name} overlaps with native Antigravity tools.`,
      );
    const tool = schemas.find((s) => s.name === name);
    if (!tool) throw new Error(`Selected DSH MCP tool is unavailable: ${name}`);
    return {
      ...tool,
      mcpName:
        name === "web_reader"
          ? "web_reader"
          : `extension_${i}_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}`,
    };
  });
}

/** Authenticated loopback MCP endpoint; the official agent connects via stdio. */
export class DshMcpBridge {
  private server?: Server;
  private token = randomUUID();
  private endpoint = "";
  private active = new Set<Promise<any>>();
  private toolTail: Promise<void> = Promise.resolve();
  private directory?: string;
  constructor(
    public tools: any[],
    private invoke: (name: string, args: any) => Promise<any>,
  ) {}
  setInvoker(invoke: (name: string, args: any) => Promise<any>) {
    this.invoke = invoke;
  }
  async start() {
    this.directory = await mkdtemp(join(tmpdir(), "web-tools-mcp-"));
    await copyFile(
      fileURLToPath(new URL("./google-acp-mcp-stdio.mjs", import.meta.url)),
      join(this.directory, "server.mjs"),
    );
    this.server = createServer(async (req, res) => {
      if (
        req.method !== "POST" ||
        req.url !== `/${this.token}` ||
        req.headers.authorization !== `Bearer ${this.token}`
      ) {
        res.writeHead(404).end();
        return;
      }
      let id: any;
      try {
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
          size += part.length;
          if (size > 8 * 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          parts.push(part);
        }
        const message = JSON.parse(Buffer.concat(parts).toString("utf8"));
        id = message.id;
        if (id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const work = this.handle(message);
        this.active.add(work);
        let result;
        try {
          result = await work;
        } finally {
          this.active.delete(work);
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch {
        if (!res.destroyed)
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: id ?? null,
              error: { code: -32603, message: "Extension tool request failed" },
            }),
          );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as any;
    this.endpoint = `http://127.0.0.1:${address.port}/${this.token}`;
  }
  descriptor() {
    return {
      name: "google-acp-extensions",
      command: process.execPath,
      args: [join(this.directory!, "server.mjs")],
      env: [
        { name: "GOOGLE_ACP_MCP_ENDPOINT", value: this.endpoint },
        { name: "GOOGLE_ACP_MCP_TOKEN", value: this.token },
      ],
    };
  }
  private async handle(message: any) {
    if (message.method === "initialize")
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "google-acp-extensions", version: "0.1.0" },
      };
    if (message.method === "ping") return {};
    if (message.method === "tools/list")
      return {
        tools: this.tools.map((t) => ({
          name: t.mcpName,
          description: t.description,
          inputSchema: t.parameters,
        })),
      };
    if (message.method === "tools/call") {
      const tool = this.tools.find((t) => t.mcpName === message.params?.name);
      if (!tool)
        return {
          isError: true,
          content: [
            { type: "text", text: "Unknown or unselected extension tool" },
          ],
        };
      // Separate MCP requests are separate DSH batches. Keep exclusive tools
      // from overlapping across those batches.
      const result = this.toolTail.then(() =>
        this.invoke(tool.name, message.params.arguments ?? {}),
      );
      this.toolTail = result.then(
        () => {},
        () => {},
      );
      return result;
    }
    throw new Error("Unsupported MCP method");
  }
  async close() {
    if (!this.server) {
      if (this.directory)
        await rm(this.directory, { recursive: true, force: true });
      return;
    }
    const closing = new Promise<void>((resolve) =>
      this.server!.close(() => resolve()),
    );
    this.server.closeIdleConnections();
    // Caller aborts tool signals before closing; do not abandon executing tools.
    await Promise.allSettled([...this.active]);
    this.server.closeAllConnections();
    await closing;
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
}
