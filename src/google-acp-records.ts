import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";

export type SessionRecordWriter = (
  session: any,
  type: string,
  data: any,
) => unknown;
export const appendAcpRecord: SessionRecordWriter = (session, type, data) =>
  (appendPluginRecord as SessionRecordWriter)(session, type, data);

/** Keep the profile loader's Session identity for private record commits. */
export async function hostAcpRecordWriter(): Promise<SessionRecordWriter> {
  const { appendPluginRecord: write } = await hostModule("@deepseek-ai/dsh-session");
  return write;
}

/** Use the running harness's package version, including its class identities. */
export async function hostModule(name: string): Promise<any> {
  const entry = process.argv[1];
  const require = createRequire(
    entry && isAbsolute(entry) ? pathToFileURL(entry) : import.meta.url,
  );
  return import(pathToFileURL(require.resolve(name)).href);
}
