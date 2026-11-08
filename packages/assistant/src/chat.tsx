// The assistant's chat, in a view: the kit's Chat over its `chat@1` slot. The record and the
// status come from the slot; the view keeps only what it shows.
import { chat, uiShell, uiView } from "@agentorg/interfaces";
import { Button, Chat, type ChatEntry } from "@agentorg/kit";
import { type Context, defineWidget, NotConnected, Refused } from "@agentorg/sdk";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MANAGE_USAGE, type Notice, noticeOf } from "./notice.ts";

const PAGE = 100;

/** A failure as the code and message a notice is made from. */
const codeOf = (error: unknown) => ({
  code:
    error instanceof Refused
      ? error.code
      : error instanceof NotConnected
        ? "not_connected"
        : "failed",
  message: error instanceof Error ? error.message : "That didn't work.",
});

type ViewContext = Context<{ chat: typeof chat; shell: typeof uiShell }, { view: typeof uiView }>;

export default defineWidget({
  slots: { chat, shell: uiShell },
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(root) {
        // A root of its own inside the frame's body, filling it.
        const host = root.ownerDocument.createElement("div");
        host.style.height = "100%";
        root.replaceChildren(host);
        const react = createRoot(host);
        react.render(<ChatView ctx={ctx} />);
        return () => react.unmount();
      },
    });
  },
});

const busyOf = (state: string) => state === "thinking" || state === "tool";

/**
 * A notice, and whether a good read of the record ends it: a failed read, or the chat not being
 * there. Those say nothing about a turn, so they can't outlast their cause.
 */
type Shown = Notice & { untilRead?: boolean };

/** A message the person sent that the record doesn't have yet; `messageId` once `send` says it. */
interface Sending {
  id: string;
  text: string;
  messageId?: string;
}

function ChatView({ ctx }: { ctx: ViewContext }) {
  const slot = ctx.slots.chat;
  /** The record, in order, and the text still streaming by id. */
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Shown>();
  /** What the person sent, shown at once, until the record has it. */
  const [sending, setSending] = useState<readonly Sending[]>([]);
  /** Whether older messages remain before the first one shown. */
  const [hasEarlier, setHasEarlier] = useState(false);
  // What the async reads below merge into: always the latest.
  const shown = useRef(messages);
  shown.current = messages;
  const sends = useRef(0);

  const failed = (error: unknown) =>
    setNotice({ ...noticeOf(codeOf(error)), untilRead: error instanceof NotConnected });

  useEffect(() => {
    let live = true;
    /**
     * The record and the status now, read again whenever the chat becomes usable; the record
     * outranks what streamed, and the status says whether a turn is running. Only what arrives
     * while the page is read is newer than it.
     */
    const load = () => {
      const since = shown.current.length;
      Promise.all([slot.call.history({ limit: PAGE }), slot.call.state({})])
        .then(([{ messages: page, more }, now]) => {
          if (!live) return;
          const known = new Set(page.map((m) => m.id));
          setMessages([...page, ...shown.current.slice(since).filter((m) => !known.has(m.id))]);
          setHasEarlier(more);
          setBusy(busyOf(now.state));
          setNotice((was) =>
            now.state === "error" && now.detail
              ? noticeOf(now.detail)
              : was?.untilRead
                ? undefined
                : was,
          );
        })
        .catch((error) => {
          // Not there yet (its process is still starting, say): `onBind` reads again when it is.
          if (live && !(error instanceof NotConnected))
            setNotice({ ...noticeOf(codeOf(error)), untilRead: true });
        });
    };
    const off = [
      slot.on("message", (message) => {
        setStreaming((was) => {
          if (!was.has(message.id)) return was;
          const next = new Map(was);
          next.delete(message.id);
          return next;
        });
        // The record has what the person sent: it takes the place of the one shown at once.
        if (message.role === "user")
          setSending((was) => {
            const at = was.findIndex((m) => m.text === message.text);
            return at === -1 ? was : was.filter((_, i) => i !== at);
          });
        // The latest word on an id replaces the earlier: a tool call running, then ended.
        setMessages((was) => {
          const at = was.findIndex((m) => m.id === message.id);
          return at === -1 ? [...was, message] : was.map((m, i) => (i === at ? message : m));
        });
      }),
      slot.on("delta", ({ id, text }) => {
        // A late piece of a reply already settled changes nothing.
        if (shown.current.some((m) => m.id === id)) return;
        setStreaming((was) => new Map(was).set(id, (was.get(id) ?? "") + text));
      }),
      slot.on("status", (status) => {
        setBusy(busyOf(status.state));
        if (status.state === "thinking") setNotice(undefined);
        // A reply cut off by a cancel or an error never settles: it goes.
        if (status.state === "idle" || status.state === "error") setStreaming(new Map());
        if (status.state === "error" && status.detail) setNotice(noticeOf(status.detail));
      }),
      slot.onBind(load),
    ];
    if (slot.bound) load();
    return () => {
      live = false;
      for (const stop of off) stop();
    };
  }, [slot]);

  const run = (action: NonNullable<Notice["action"]>["run"]) => {
    if (action === "manage") ctx.slots.shell.call.openExternal({ url: MANAGE_USAGE }).catch(failed);
    else if (action === "signIn") ctx.slots.shell.call.signIn({}).catch(failed);
    else {
      // Retry runs the last turn again, without sending the message a second time.
      setNotice(undefined);
      slot.call.retry({}).catch(failed);
    }
  };
  /** The page before the oldest message shown. */
  const earlier = async () => {
    const oldest = shown.current[0];
    if (!oldest) return;
    const { messages: page, more } = await slot.call
      .history({ before: oldest.id, limit: PAGE })
      .catch((error) => {
        failed(error);
        return { messages: [], more: true };
      });
    setMessages((was) => {
      const known = new Set(was.map((m) => m.id));
      return [...page.filter((m) => !known.has(m.id)), ...was];
    });
    setHasEarlier(more);
  };

  const action = notice?.action;
  // Retry needs a message of the person's to run again.
  const offered = action && (action.run !== "retry" || messages.some((m) => m.role === "user"));
  const recorded = new Set(messages.map((m) => m.id));
  const unrecorded = sending.filter((m) => !m.messageId || !recorded.has(m.messageId));
  return (
    <Chat
      messages={[
        ...messages,
        ...unrecorded.map(({ id, text }) => ({ id, role: "user" as const, text })),
        ...[...streaming].map(([id, text]) => ({ id, role: "assistant" as const, text })),
      ]}
      running={busy || sending.some((m) => !m.messageId)}
      onSend={async (text) => {
        setNotice(undefined);
        const id = `sending-${++sends.current}`;
        setSending((was) => [...was, { id, text }]);
        try {
          const { messageId } = await slot.call.send({ text });
          setSending((was) => was.map((m) => (m.id === id ? { ...m, messageId } : m)));
        } catch (error) {
          setSending((was) => was.filter((m) => m.id !== id));
          failed(error);
          throw error;
        }
      }}
      onCancel={() => void slot.call.cancel({}).catch(failed)}
      onRetry={() => run("retry")}
      hasEarlier={hasEarlier}
      onEarlier={earlier}
      notice={
        notice && (
          <>
            {notice.title && <b>{notice.title}</b>}
            <span>{notice.text}</span>
            {offered && (
              <div>
                <Button variant="primary" onClick={() => run(action.run)}>
                  {action.label}
                </Button>
              </div>
            )}
          </>
        )
      }
      footer={
        <span>
          Using ChatGPT plan ·{" "}
          <Button variant="quiet" onClick={() => run("manage")}>
            Manage usage
          </Button>
        </span>
      }
    />
  );
}
