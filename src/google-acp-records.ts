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

/** Resolve the composition helpers from the CLI installation. Session records
 * must use the static import above so the profile loader shares the Session class. */
export async function hostModule(name: string): Promise<any> {
  const entry = process.argv[1];
  const require = createRequire(
    entry && isAbsolute(entry) ? pathToFileURL(entry) : import.meta.url,
  );
  return import(pathToFileURL(require.resolve(name)).href);
}
