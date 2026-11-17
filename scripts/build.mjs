import { build } from "esbuild";
import { mkdir, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
// Only the fixed generated directory inside this package is replaced.
const output = fileURLToPath(new URL("../lib/", import.meta.url));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const entryPoints = Object.fromEntries(
  (await readdir("src"))
    .filter((name) => name.startsWith("google-acp") && name.endsWith(".ts"))
    .map((name) => [name.slice(0, -3), `src/${name}`]),
);
await build({
  entryPoints,
  outdir: "lib",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
await copyFile("src/google-acp-mcp-stdio.mjs", "lib/google-acp-mcp-stdio.mjs");
const client = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "react-dom", "react/jsx-runtime", "@deepseek-ai/cordis"],
  jsx: "automatic",
});
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:"@yu1745/dsh-agy-acp",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
