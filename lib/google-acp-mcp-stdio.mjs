// Official Antigravity launches this process as an ordinary stdio MCP server.
import { createInterface } from "node:readline";
const endpoint = process.env.GOOGLE_ACP_MCP_ENDPOINT;
const token = process.env.GOOGLE_ACP_MCP_TOKEN;
if (!endpoint || !token || !endpoint.startsWith("http://127.0.0.1:"))
  process.exit(1);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const active = new Set();
async function forward(line) {
  let id = null;
  try {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw Error("oversized");
    const message = JSON.parse(line);
    id = message.id;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: line,
    });
    if (!response.ok) throw Error("MCP bridge unavailable");
    if (id !== undefined) process.stdout.write((await response.text()) + "\n");
  } catch {
    if (id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Extension tool bridge unavailable" },
        }) + "\n",
      );
  }
}
lines.on("line", (line) => {
  const work = forward(line);
  active.add(work);
  void work.finally(() => active.delete(work));
});
lines.on("close", async () => {
  await Promise.allSettled([...active]);
});
