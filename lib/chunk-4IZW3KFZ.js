// src/google-acp-rpc.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
var AcpRpcError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  code;
};
var AcpConnection = class {
  child;
  sequence = 0;
  pending = /* @__PURE__ */ new Map();
  stopped;
  onNotification = () => {
  };
  onRequest = async () => {
    throw new AcpRpcError("Unsupported client request", -32601);
  };
  onClose = () => {
  };
  constructor(command, args, cwd, credentialStore = "auto") {
    const env = { ...process.env };
    if (credentialStore === "file") {
      if (process.platform !== "linux")
        throw new AcpRpcError("File credential mode currently requires Linux.");
      env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/dev/null";
    }
    for (const key of [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GENAI_USE_VERTEXAI"
    ])
      delete env[key];
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {
    });
    this.child.on(
      "error",
      (e) => this.fail(
        new AcpRpcError(`Cannot start official ACP agent: ${e.message}`)
      )
    );
    this.child.on(
      "exit",
      (code, signal) => this.fail(
        new AcpRpcError(`Official ACP agent exited (${signal ?? code}).`)
      )
    );
    let lineBytes = 0;
    this.child.stdout.on("data", (data) => {
      const lastNewline = data.lastIndexOf(10);
      lineBytes = lastNewline < 0 ? lineBytes + data.length : data.length - lastNewline - 1;
      if (lineBytes > 8 * 1024 * 1024)
        this.close(new AcpRpcError("ACP message exceeds 8 MiB."));
    });
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity
    });
    lines.on("line", (line) => {
      if (!line.trim() || this.stopped) return;
      try {
        if (Buffer.byteLength(line) > 8 * 1024 * 1024)
          throw new Error("oversized");
        const msg = JSON.parse(line);
        if (msg.jsonrpc !== "2.0" || typeof msg !== "object")
          throw new Error("invalid envelope");
        if (typeof msg.method === "string") {
          if (msg.id === void 0) this.onNotification(msg.method, msg.params);
          else void this.respond(msg);
        } else {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error)
            pending.reject(
              new AcpRpcError(
                msg.error.message || "ACP request failed",
                msg.error.code
              )
            );
          else if (Object.hasOwn(msg, "result")) pending.resolve(msg.result);
          else pending.reject(new AcpRpcError("Invalid ACP response"));
        }
      } catch {
        this.close(
          new AcpRpcError("Official ACP agent returned invalid JSON-RPC.")
        );
      }
    });
    this.child.on("close", () => lines.close());
  }
  async respond(msg) {
    try {
      const result = await this.onRequest(msg.method, msg.params);
      this.send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: e instanceof AcpRpcError ? e.code ?? -32603 : -32603,
          message: "Client request unavailable or rejected"
        }
      });
    }
  }
  send(msg) {
    if (this.stopped) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  request(method, params, timeoutMs = 3e4) {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(
        () => this.close(new AcpRpcError(`ACP ${method} timed out.`)),
        timeoutMs
      ) : void 0;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  fail(error) {
    if (this.stopped) return;
    this.stopped = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
  }
  close(error = new AcpRpcError("ACP connection closed.")) {
    this.fail(error);
    this.child.stdin.end();
    const kill = (signal) => {
      try {
        if (this.child.pid && process.platform !== "win32")
          process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch {
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1500);
    timer.unref();
  }
};

export {
  AcpRpcError,
  AcpConnection
};
//# sourceMappingURL=chunk-4IZW3KFZ.js.map
