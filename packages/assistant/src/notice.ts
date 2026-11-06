/** What the chat view shows when a turn ends in error, in OpenAI's words for plan usage. */

export const MANAGE_USAGE = "https://chatgpt.com/settings/usage";

export interface Notice {
  title?: string;
  text: string;
  /** The main action: open usage settings, start sign-in, or send the last message again. */
  action?: { label: string; run: "manage" | "signIn" | "retry" };
}

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
      return {
        text: "ChatGPT plan usage is unavailable right now.",
        action: { label: "Retry", run: "retry" },
      };
    case "ineligible":
      return { text: "This ChatGPT account isn't eligible to use its plan in this app." };
    default:
      return { text: detail.message };
  }
}
