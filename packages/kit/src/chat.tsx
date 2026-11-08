// A conversation with an agent, on assistant-ui's primitives (Thread, Message, Composer,
// ActionBar) over an external store: the caller keeps the messages and runs the turns.
import {
  ActionBarPrimitive,
  type AppendMessage,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { IconButton } from "./components.tsx";
import { ChevronIcon, CopyIcon, RetryIcon, SendIcon, StopIcon, ToolIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";

/** One message of a chat, as `chat@1` carries it. A `tool` message may say which tool ran. */
export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tool?: {
    name: string;
    state: "running" | "done" | "refused";
    input?: string;
    output?: string;
  };
}

export interface ChatProps {
  /** In order; a reply still streaming is an `assistant` entry like any other. */
  messages: readonly ChatEntry[];
  /** A turn is running: Send becomes Stop. */
  running: boolean;
  /** Send the person's text; when it rejects, the text goes back in the composer. */
  onSend(text: string): Promise<void>;
  onCancel(): void;
  /** Run the last turn again: offered under the last reply. */
  onRetry?(): void;
  /** Older messages remain: "Earlier messages" loads them. */
  hasEarlier?: boolean;
  onEarlier?(): Promise<void>;
  /** Above the composer: a notice the caller draws (a refusal and its action). */
  notice?: ReactNode;
  /** Beside the send button: the plan line, say. */
  footer?: ReactNode;
  /** The agent's name and avatar, over its replies; its name names the composer. */
  name?: string;
  avatar?: ReactNode;
  /** The composer's accessible name; by default "Message". */
  label?: string;
}

/**
 * The entries as assistant-ui's messages: a person's message each, and every run of replies and
 * tool messages between two of theirs as one reply whose parts are in order. A tool message is a
 * tool-call part that keeps its entry, so a card can be drawn from it.
 */
function threadOf(entries: readonly ChatEntry[], running: boolean): ThreadMessageLike[] {
  const thread: ThreadMessageLike[] = [];
  let reply: { id: string; content: ThreadMessageLike["content"] & unknown[] } | undefined;
  const close = () => {
    if (reply) thread.push({ role: "assistant", id: reply.id, content: reply.content });
    reply = undefined;
  };
  for (const entry of entries) {
    if (entry.role === "user") {
      close();
      thread.push({ role: "user", id: entry.id, content: [{ type: "text", text: entry.text }] });
      continue;
    }
    reply ??= { id: entry.id, content: [] };
    reply.content.push(
      entry.role === "assistant"
        ? { type: "text", text: entry.text }
        : {
            type: "tool-call",
            toolCallId: entry.id,
            toolName: entry.tool?.name ?? "",
            argsText: entry.tool?.input ?? "",
            artifact: entry,
          },
    );
  }
  close();
  const last = thread.at(-1);
  if (running && last?.role === "assistant")
    thread[thread.length - 1] = { ...last, status: { type: "running" } };
  return thread;
}

const textOf = (message: AppendMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

export function Chat(props: ChatProps) {
  const { messages, running, onSend, onCancel, onRetry, hasEarlier, onEarlier } = props;
  // A refused send puts its text back, into the composer the runtime keeps.
  const [kept, setKept] = useState<{ text: string; n: number }>();
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: threadOf(messages, running),
    convertMessage: (message) => message,
    isRunning: running,
    onNew: async (message) => {
      const text = textOf(message);
      try {
        await onSend(text);
      } catch {
        setKept((was) => ({ text, n: (was?.n ?? 0) + 1 }));
      }
    },
    onCancel: async () => onCancel(),
    // The options keep one shape whatever is given: the runtime doesn't take a change of shape.
    onReload: async () => onRetry?.(),
    hasEarlier: !!(hasEarlier && onEarlier),
    onLoadEarlier: async () => onEarlier?.(),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread {...props} kept={kept} />
    </AssistantRuntimeProvider>
  );
}

function Thread({
  notice,
  footer,
  name,
  avatar,
  label = "Message",
  kept,
  running,
  onRetry,
}: ChatProps & { kept?: { text: string; n: number } }) {
  return (
    <Agent.Provider value={{ name, avatar, retry: !!onRetry }}>
      <ThreadPrimitive.Root className="kit-chat">
        <ThreadPrimitive.Viewport
          className="kit-chat-viewport"
          role="log"
          aria-label="Conversation"
        >
          <div className="kit-chat-thread">
            <Earlier />
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            {running && <Thinking />}
          </div>
        </ThreadPrimitive.Viewport>
        {notice && (
          <div className="kit-chat-notice" role="alert">
            {notice}
          </div>
        )}
        <div className="kit-chat-composer-wrap">
          <ComposerPrimitive.Root className="kit-chat-composer">
            <Input label={label} placeholder={name ? `Message ${name}` : label} />
            <Restore kept={kept} />
            <div className="kit-chat-composer-row">
              {footer}
              {running ? (
                <ComposerPrimitive.Cancel className="kit-chat-send" aria-label="Stop">
                  <StopIcon />
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send className="kit-chat-send" aria-label="Send">
                  <SendIcon />
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </Agent.Provider>
  );
}

/**
 * The field. Enter sends through the composer itself, not the form: a frame sandboxed without
 * allow-forms never fires a form's submit. Shift+Enter is a new line, Enter mid-composition
 * belongs to the input method, and during a turn Enter does nothing: Stop is a deliberate click.
 */
function Input({ label, placeholder }: { label: string; placeholder: string }) {
  const aui = useAui();
  return (
    <ComposerPrimitive.Input
      className="kit-chat-input"
      aria-label={label}
      placeholder={placeholder}
      submitMode="none"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (aui.thread.getState().isRunning) return;
        // The field's own text, for the composer's state can lag it on a busy machine.
        aui.composer.setText(event.currentTarget.value);
        aui.composer.send();
      }}
    />
  );
}

/** "Earlier messages", only while there are some. */
function Earlier() {
  const some = useAuiState(({ thread }) => thread.hasEarlier);
  if (!some) return null;
  return (
    <ThreadPrimitive.LoadEarlier className="kit-chat-earlier">
      Earlier messages
    </ThreadPrimitive.LoadEarlier>
  );
}

/** Puts a refused send's text back in the composer, once per refusal. */
function Restore({ kept }: { kept: { text: string; n: number } | undefined }) {
  const aui = useAui();
  useEffect(() => {
    if (kept) aui.composer.setText(kept.text);
  }, [aui, kept]);
  return null;
}

/** Who the replies are from, and whether they offer Retry: for every reply in the thread. */
const Agent = createContext<{ name: string | undefined; avatar: ReactNode; retry: boolean }>({
  name: undefined,
  avatar: undefined,
  retry: false,
});

const PlainText = ({ text }: { text: string }) => <>{text}</>;
const MarkdownText = ({ text }: { text: string }) => <Markdown text={text} />;
const USER_PARTS = { Text: PlainText };
const REPLY_PARTS = { Text: MarkdownText, tools: { Override: Tool } };

const UserMessage = () => (
  <MessagePrimitive.Root className="kit-chat-user">
    <MessagePrimitive.Parts components={USER_PARTS} />
  </MessagePrimitive.Root>
);

/** Dots while the turn has nothing to show yet: before the first text or tool of its reply. */
function Thinking() {
  const shown = useAuiState(({ thread }) => {
    const last = thread.messages.at(-1);
    return last?.role === "assistant" && last.content.length > 0;
  });
  if (shown) return null;
  return (
    <div className="kit-chat-thinking" role="status" aria-label="Thinking">
      <i />
      <i />
      <i />
    </div>
  );
}

function AssistantMessage() {
  const { name, avatar, retry } = useContext(Agent);
  const running = useAuiState(({ message }) => message.status?.type === "running");
  // Retry runs the last turn again, so only the last reply offers it; earlier replies show their
  // bar on hover.
  const last = useAuiState(({ message }) => message.isLast);
  return (
    <MessagePrimitive.Root className="kit-chat-assistant" {...(last ? { "data-last": "" } : {})}>
      {name && (
        <div className="kit-chat-who">
          {avatar}
          {name}
        </div>
      )}
      <MessagePrimitive.Parts components={REPLY_PARTS} />
      {/* The room is kept while the reply runs, so nothing moves when its buttons come. */}
      <ActionBarPrimitive.Root className="kit-chat-bar" {...(running ? { "data-hidden": "" } : {})}>
        <ActionBarPrimitive.Copy asChild>
          <IconButton label="Copy">
            <CopyIcon />
          </IconButton>
        </ActionBarPrimitive.Copy>
        {retry && last && (
          <ActionBarPrimitive.Reload asChild>
            <IconButton label="Retry">
              <RetryIcon />
            </IconButton>
          </ActionBarPrimitive.Reload>
        )}
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

/**
 * A tool message: a card with the tool's name and how it ended, opened for what went in and what
 * came back, when the message says which tool ran; otherwise the one line it is.
 */
function Tool({ artifact }: ToolCallMessagePartProps) {
  const entry = artifact as ChatEntry;
  const [open, setOpen] = useState(false);
  const tool = entry.tool;
  if (!tool) return <div className="kit-chat-step">{entry.text}</div>;
  const body = [tool.input, tool.output && `→ ${tool.output}`].filter(Boolean).join("\n");
  return (
    <div className="kit-tool" {...(open ? { "data-open": "" } : {})}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ToolIcon />
        <span className="kit-tool-title">{entry.text}</span>
        <span className="kit-tool-name">{tool.name}</span>
        {tool.state === "done" ? (
          <span className="kit-tool-done" role="img" aria-label="done">
            ✓
          </span>
        ) : tool.state === "refused" ? (
          <span className="kit-tool-refused">refused</span>
        ) : (
          <span className="kit-chat-thinking" role="status" aria-label="running">
            <i />
          </span>
        )}
        <ChevronIcon className="kit-tool-chevron" />
      </button>
      {open && body && <pre className="kit-tool-body">{body}</pre>}
    </div>
  );
}
