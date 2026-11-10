// What a chat's problem says, and what can be done about it: one meaning for the chat and the agent page.

export interface Notice {
  title?: string;
  text: string;
  action?: { label: string; run: "manage" | "signIn" };
  /** A failed read, or the chat not being there: a good read ends it. */
  untilRead?: boolean;
}

/** What a message that got no answer shows, in OpenAI's words for plan usage. */
export function noticeOf(detail: { code: string; message: string }): Notice {
  switch (detail.code) {
    case "usage_limit":
      return {
        title: "Usage limit reached",
        text: "Review your plan or this app's limit in ChatGPT settings.",
        action: { label: "Manage usage", run: "manage" },
      };
    case "not_signed_in":
      return {
        text: "Sign in with ChatGPT to chat on your plan.",
        action: { label: "Continue with ChatGPT", run: "signIn" },
      };
    case "unavailable":
      return { text: "ChatGPT plan usage is unavailable right now." };
    case "ineligible":
      return { text: "This ChatGPT account isn't eligible to use its plan in this app." };
    default:
      return { text: detail.message };
  }
}
