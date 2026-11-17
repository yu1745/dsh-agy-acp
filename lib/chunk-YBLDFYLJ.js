// src/google-acp-mcp.ts
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function selectMcpTools(schemas, allow) {
  const nativeDuplicates = /^(?:bash|sh|shell|pwsh|terminal|read|write|edit|apply_patch|grep|glob|ls|read_file|write_file|edit_file|view_file|run_command|replace_file_content|find_by_name|grep_search|list_dir|todo_write|update_plan|subagent|spawn_agent|fork_agent)$/i;
  if (new Set(allow).size !== allow.length)
    throw new Error("Duplicate Google ACP MCP tool selection.");
  return allow.map((name, i) => {
    if (nativeDuplicates.test(name))
      throw new Error(
        `DSH tool ${name} overlaps with native Antigravity tools.`
      );
    const tool = schemas.find((s) => s.name === name);
    if (!tool) throw new Error(`Selected DSH MCP tool is unavailable: ${name}`);
    return {
      ...tool,
      mcpName: name === "web_reader" ? "web_reader" : `extension_${i}_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}`
    };
  });
}
var DshMcpBridge = class {
  constructor(tools, invoke) {
    this.tools = tools;
    this.invoke = invoke;
  }
  tools;
  invoke;
  server;
  token = randomUUID();
  endpoint = "";
  active = /* @__PURE__ */ new Set();
  toolTail = Promise.resolve();
  directory;
  async start() {
    this.directory = await mkdtemp(join(tmpdir(), "web-tools-mcp-"));
    await copyFile(
      fileURLToPath(new URL("./google-acp-mcp-stdio.mjs", import.meta.url)),
      join(this.directory, "server.mjs")
    );
    this.server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== `/${this.token}` || req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(404).end();
        return;
      }
      let id;
      try {
        const parts = [];
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
        if (id === void 0) {
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
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch {
        if (!res.destroyed)
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: id ?? null,
              error: { code: -32603, message: "Extension tool request failed" }
            })
          );
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    this.endpoint = `http://127.0.0.1:${address.port}/${this.token}`;
  }
  descriptor() {
    return {
      name: "google-acp-extensions",
      command: process.execPath,
      args: [join(this.directory, "server.mjs")],
      env: [
        { name: "GOOGLE_ACP_MCP_ENDPOINT", value: this.endpoint },
        { name: "GOOGLE_ACP_MCP_TOKEN", value: this.token }
      ]
    };
  }
  async handle(message) {
    if (message.method === "initialize")
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "google-acp-extensions", version: "0.1.0" }
      };
    if (message.method === "ping") return {};
    if (message.method === "tools/list")
      return {
        tools: this.tools.map((t) => ({
          name: t.mcpName,
          description: t.description,
          inputSchema: t.parameters
        }))
      };
    if (message.method === "tools/call") {
      const tool = this.tools.find((t) => t.mcpName === message.params?.name);
      if (!tool)
        return {
          isError: true,
          content: [
            { type: "text", text: "Unknown or unselected extension tool" }
          ]
        };
      const result = this.toolTail.then(
        () => this.invoke(tool.name, message.params.arguments ?? {})
      );
      this.toolTail = result.then(
        () => {
        },
        () => {
        }
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
    const closing = new Promise(
      (resolve) => this.server.close(() => resolve())
    );
    this.server.closeIdleConnections();
    await Promise.allSettled([...this.active]);
    this.server.closeAllConnections();
    await closing;
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
};

export {
  selectMcpTools,
  DshMcpBridge
};
//# sourceMappingURL=chunk-YBLDFYLJ.js.map
