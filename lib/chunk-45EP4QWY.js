// src/google-acp-records.ts
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
var appendAcpRecord = (session, type, data) => appendPluginRecord(session, type, data);
async function hostAcpRecordWriter() {
  return appendAcpRecord;
}
async function hostModule(name) {
  const entry = process.argv[1];
  const require2 = createRequire(
    entry && isAbsolute(entry) ? pathToFileURL(entry) : import.meta.url
  );
  return import(pathToFileURL(require2.resolve(name)).href);
}

export {
  appendAcpRecord,
  hostAcpRecordWriter,
  hostModule
};
//# sourceMappingURL=chunk-45EP4QWY.js.map
