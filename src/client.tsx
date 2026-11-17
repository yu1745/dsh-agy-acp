import { installGoogleAcpCalls } from "./google-acp-client.js";

export const inject = ["slots", "uiConversation", "modelDirectories"];

export function apply(ctx: any) {
  installGoogleAcpCalls(ctx);
}
