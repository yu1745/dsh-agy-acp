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

/** Resolve the host's exact installation: the record commit uses a private
 * Session class field and cannot be called across duplicate installed copies.
 */
export async function hostAcpRecordWriter(): Promise<SessionRecordWriter> {
  const entry = process.argv[1];
  if (!entry || !isAbsolute(entry)) return appendAcpRecord;
  const require = createRequire(pathToFileURL(entry));
  const host = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-session")).href
  );
  return (session, type, data) => host.appendPluginRecord(session, type, data);
}

/** Use the running harness's package version, including its class identities. */
export async function hostModule(name: string): Promise<any> {
  const entry = process.argv[1];
  const require = createRequire(
    entry && isAbsolute(entry) ? pathToFileURL(entry) : import.meta.url,
  );
  return import(pathToFileURL(require.resolve(name)).href);
}
