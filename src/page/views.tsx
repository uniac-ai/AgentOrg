/**
 * The decisions page's HTML, as server-side JSX: `hono/jsx` escapes every text and attribute
 * value, so text an agent wrote cannot become markup. The only raw HTML is the page's own
 * stylesheet. The views hold no state; the routes hand them a model and a context.
 */

import { html, raw } from "hono/html";
import type { Child } from "hono/jsx";
import { LIMITS } from "../contract/index.ts";
import type {
  AgentRecord,
  AskRecord,
  Chain,
  Context,
  Decisions,
  Inspection,
  MessageRecord,
  Summary,
  TreeNode,
} from "./model.ts";
import { STYLESHEET } from "./stylesheet.ts";

/** How long ago, roughly: "just now", "12 min ago", "5 h ago", "3 days ago". */
export function ago(at: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} days ago`;
}

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;
const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const isWebLink = (url: string) => /^https?:\/\//i.test(url);
export const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;

function document(title: string, body: Child) {
  return html`<!doctype html>${(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style>{raw(STYLESHEET)}</style>
      </head>
      <body>
        <header class="top">
          <h1>
            <a href="/">agentorg decisions</a>
          </h1>
        </header>
        <main>{body}</main>
      </body>
    </html>
  )}`;
}

function Ago({ at }: { at: string }) {
  return (
    <time datetime={at} title={new Date(at).toLocaleString()}>
      {ago(at)}
    </time>
  );
}

/** An agent's name, linked to its page; null is the user. */
function Name({ id, ctx }: { id: string | null; ctx: Context }) {
  if (id === null) return <>you</>;
  return <a href={agentPath(id)}>{ctx.agents.get(id)?.title ?? id}</a>;
}

const nameOf = (id: string | null, ctx: Context) =>
  id === null ? "you" : (ctx.agents.get(id)?.title ?? id);

function StateBadge({ agent }: { agent: AgentRecord }) {
  const state = agent.state === "active" ? agent.status?.state : agent.state;
  return state ? <span class={`badge state-${state}`}>{capitalized(state)}</span> : null;
}

/** What the record holds for a settled ask, from the user's side. */
export function outcome(ask: AskRecord, ctx: Context): string {
  const answer = ask.answer;
  if (ask.state === "withdrawn" || answer === null) return "Withdrawn";
  const who =
    answer.by !== null
      ? `Answered by ${nameOf(answer.by, ctx)}`
      : ask.to !== null
        ? "You stepped in"
        : answer.channel === "session"
          ? "Answered in the session"
          : "Answered";
  return answer.choice === null ? who : `${who}: ${answer.choice}`;
}

function Settled({ ctx }: { ctx: Context }) {
  const settled = ctx.settled;
  if (settled === undefined) return null;
  return (
    <div class="settled" role="status" tabindex={-1} autofocus>
      {"options" in settled ? (
        <>
          <p>
            <strong>{settled.title}</strong>
          </p>
          <p>{outcome(settled, ctx)}</p>
          {settled.answer?.words ? <blockquote>{settled.answer.words}</blockquote> : null}
        </>
      ) : (
        <p>Closed {settled.title}</p>
      )}
    </div>
  );
}

function ChainList({ chains, ctx }: { chains: Chain[]; ctx: Context }) {
  return (
    <ol class="chain" aria-label="Carried up">
      {chains.map(({ ask, carries }) => (
        <li>
          <Name id={ask.agent} ctx={ctx} /> asked <Name id={ask.to} ctx={ctx} /> ·{" "}
          <Ago at={ask.opened_at} />
          <span class="chain-ask">{ask.title}</span>
          {carries.length > 0 ? <ChainList chains={carries} ctx={ctx} /> : null}
        </li>
      ))}
    </ol>
  );
}

function AnswerForm({ ask, ctx, back }: { ask: AskRecord; ctx: Context; back: string }) {
  const refusal = ctx.refusal?.target === ask.id ? ctx.refusal : undefined;
  const steppingIn = ask.to !== null;
  return (
    <form method="post" action={`/ui/asks/${encodeURIComponent(ask.id)}/answer`}>
      <input type="hidden" name="csrf" value={ctx.csrfToken} />
      <input type="hidden" name="back" value={back} />
      {steppingIn ? (
        <p class="step-in">
          You are stepping in for {nameOf(ask.to, ctx)}. The answer is recorded as yours.
        </p>
      ) : null}
      <fieldset class="options" aria-labelledby={`ask-${ask.id}-title`}>
        {ask.options.map((option) => (
          <label class="option">
            <input
              type="radio"
              name="choice"
              value={option.label}
              checked={refusal?.choice === option.label}
            />
            <span>
              <span class="option-label">{option.label}</span>
              {option.label === ask.recommendation ? (
                <span class="badge recommended">Recommended</span>
              ) : null}
              {option.detail ? <span class="option-detail">{option.detail}</span> : null}
            </span>
          </label>
        ))}
      </fieldset>
      <label class="note">
        <span>Note (optional)</span>
        <textarea name="words" rows={2} maxlength={LIMITS.words}>
          {refusal?.words ?? ""}
        </textarea>
      </label>
      {refusal ? (
        <p class="refusal" role="alert" tabindex={-1} autofocus>
          {refusal.message}
        </p>
      ) : null}
      <button type="submit" class="send">
        {steppingIn ? `Answer for ${nameOf(ask.to, ctx)}` : "Send answer"}
      </button>
    </form>
  );
}

/**
 * One ask: who asked whom, the chain it carries up, and its form while open or what the record
 * holds once settled. `inspecting` is the agent whose page it is on, if any.
 */
function AskCard(props: { chain: Chain; ctx: Context; back: string; inspecting?: string }) {
  const { chain, ctx, back, inspecting } = props;
  const { ask } = chain;
  const Heading = inspecting === undefined ? "h3" : "h4";
  return (
    <article class="card" id={`ask-${ask.id}`} aria-labelledby={`ask-${ask.id}-title`}>
      <Heading class="card-title" id={`ask-${ask.id}-title`}>
        {ask.title}
      </Heading>
      <p class="meta">
        {inspecting === undefined ? (
          <>
            Asked by <Name id={ask.agent} ctx={ctx} />
          </>
        ) : ask.agent === inspecting ? (
          <>
            To <Name id={ask.to} ctx={ctx} />
          </>
        ) : (
          <>
            From <Name id={ask.agent} ctx={ctx} />
          </>
        )}{" "}
        · <Ago at={ask.opened_at} />
      </p>
      {chain.carries.length > 0 ? <ChainList chains={chain.carries} ctx={ctx} /> : null}
      <p class="context">{ask.context}</p>
      {ask.state === "open" ? (
        <AnswerForm ask={ask} ctx={ctx} back={back} />
      ) : (
        <>
          <p class="outcome">{outcome(ask, ctx)}</p>
          {ask.answer?.words ? <blockquote>{ask.answer.words}</blockquote> : null}
        </>
      )}
    </article>
  );
}

function readState(message: MessageRecord): string {
  if (message.kind === "report" && message.acknowledged_at !== null) return "acknowledged";
  if (message.read_at === null) return "unread";
  return message.kind === "report" ? "read, not acknowledged" : "read";
}

/** A message waiting on the user, with the one action that settles it. */
function MessageToUser({ message, ctx }: { message: MessageRecord; ctx: Context }) {
  const report = message.kind === "report";
  return (
    <article class="card" aria-labelledby={`message-${message.id}-title`}>
      <h3 class="card-title" id={`message-${message.id}-title`}>
        {report ? "Report" : "Note"} from <Name id={message.from} ctx={ctx} />
      </h3>
      <p class="meta">
        <Ago at={message.sent_at} />
      </p>
      <p class="body">{message.body}</p>
      <form
        method="post"
        action={`/ui/messages/${encodeURIComponent(message.id)}/${report ? "ack" : "read"}`}
      >
        <input type="hidden" name="csrf" value={ctx.csrfToken} />
        <button type="submit" class="send">
          {report ? "Acknowledge" : "Mark read"}
        </button>
      </form>
    </article>
  );
}

function AgentCard({ summary }: { summary: Summary }) {
  const { agent, asks_to_answer, unread_messages } = summary;
  const status = agent.status;
  const waiting = [
    asks_to_answer > 0 ? `${plural(asks_to_answer, "ask")} to answer` : null,
    unread_messages > 0 ? plural(unread_messages, "unread message") : null,
  ].filter((part) => part !== null);
  return (
    <div class="card agent">
      <div class="head">
        <a class="agent-title" href={agentPath(agent.id)}>
          {agent.title}
        </a>
        <StateBadge agent={agent} />
      </div>
      {status?.summary ? <p class="summary">{status.summary}</p> : null}
      <p class="meta">
        {status ? (
          <>
            Updated <Ago at={status.updated_at} />
          </>
        ) : agent.state === "pending" ? (
          "No session has attached yet"
        ) : (
          "No status yet"
        )}
        {status?.links
          .filter((link) => isWebLink(link.url))
          .map((link) => (
            <>
              {" · "}
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            </>
          ))}
      </p>
      {status && status.blockers.length > 0 ? (
        <p class="meta">Blocked on: {status.blockers.join(", ")}</p>
      ) : null}
      {waiting.length > 0 ? <p class="waiting-on">{waiting.join(" · ")}</p> : null}
    </div>
  );
}

function Tree({ nodes, ctx, root }: { nodes: TreeNode[]; ctx: Context; root?: boolean }) {
  return (
    <ul class={root ? "tree" : undefined}>
      {nodes.map((node) => (
        <li>
          <AgentCard summary={node.summary} />
          {node.children.length > 0 ? <Tree nodes={node.children} ctx={ctx} /> : null}
        </li>
      ))}
    </ul>
  );
}

const countTree = (nodes: TreeNode[]): number =>
  nodes.reduce((sum, node) => sum + 1 + countTree(node.children), 0);

export function decisionsPage(model: Decisions, ctx: Context) {
  const waiting = model.asks.length + model.messages.length;
  const agents = countTree(model.organization);
  return document(
    `${waiting > 0 ? `(${waiting}) ` : ""}Decisions · agentorg`,
    <>
      <section>
        <h2 class="section-title">
          Waiting on you
          {waiting > 0 ? (
            <>
              {" "}
              <span class="count">{waiting}</span>
            </>
          ) : null}
        </h2>
        <Settled ctx={ctx} />
        {waiting === 0 ? <p class="empty">Nothing is waiting on you</p> : null}
        {model.asks.map((chain) => (
          <AskCard chain={chain} ctx={ctx} back="/" />
        ))}
        {model.messages.map((message) => (
          <MessageToUser message={message} ctx={ctx} />
        ))}
      </section>
      <section>
        <h2 class="section-title">
          Organization
          {agents > 0 ? (
            <>
              {" "}
              <span class="count">{agents}</span>
            </>
          ) : null}
        </h2>
        {agents === 0 ? (
          <p class="empty">No agents yet</p>
        ) : (
          <Tree nodes={model.organization} ctx={ctx} root />
        )}
      </section>
    </>,
  );
}

/** The managers above an agent, outermost first. */
function managers(agent: AgentRecord, ctx: Context): AgentRecord[] {
  const above: AgentRecord[] = [];
  for (let id = agent.manager; id !== null; ) {
    const manager = ctx.agents.get(id);
    if (manager === undefined || above.includes(manager)) break;
    above.unshift(manager);
    id = manager.manager;
  }
  return above;
}

function CloseAgent({ model, ctx }: { model: Inspection; ctx: Context }) {
  const { agent } = model.detail;
  const path = agentPath(agent.id);
  const refusal = ctx.refusal?.target === "close" ? ctx.refusal : undefined;
  const withdrawn = model.open.filter(({ ask }) => ask.agent === agent.id).length;
  return (
    <section id="close">
      <h3 class="subsection-title">Close agent</h3>
      {refusal ? (
        <p class="refusal" role="alert" tabindex={-1} autofocus>
          {refusal.message}
        </p>
      ) : null}
      {model.openChildren.length > 0 ? (
        <p class="meta">
          Close the agents under it first:{" "}
          {model.openChildren.map((child, index) => (
            <>
              {index > 0 ? ", " : ""}
              <Name id={child.id} ctx={ctx} />
            </>
          ))}
        </p>
      ) : model.confirmClose || refusal ? (
        <form method="post" action={`/ui/agents/${encodeURIComponent(agent.id)}/close`}>
          <input type="hidden" name="csrf" value={ctx.csrfToken} />
          <p class="warning">
            Closing detaches its session and withdraws its {plural(withdrawn, "open ask")}. It
            cannot be undone.
          </p>
          <div class="actions">
            <button type="submit" class="button danger confirm">
              Close {agent.title}
            </button>
            <a class="button secondary" href={path}>
              Cancel
            </a>
          </div>
        </form>
      ) : (
        <a class="button danger" href={`${path}?close=confirm#close`}>
          Close agent…
        </a>
      )}
    </section>
  );
}

export function agentPage(model: Inspection, ctx: Context) {
  const { agent, messages, sessions } = model.detail;
  const status = agent.status;
  const back = agentPath(agent.id);
  const children = [...ctx.agents.values()].filter(
    (child) => child.manager === agent.id && child.state !== "closed",
  );
  return document(
    `${agent.title} · agentorg`,
    <>
      <nav class="meta" aria-label="Managers">
        <a href="/">You</a>
        {managers(agent, ctx).map((manager) => (
          <>
            {" › "}
            <Name id={manager.id} ctx={ctx} />
          </>
        ))}
      </nav>
      <div class="head">
        <h2 class="section-title">{agent.title}</h2>
        <StateBadge agent={agent} />
      </div>
      <p class="purpose">{agent.purpose}</p>
      <dl class="facts">
        <dt>Manager</dt>
        <dd>{agent.manager === null ? "You" : <Name id={agent.manager} ctx={ctx} />}</dd>
        {status ? (
          <>
            <dt>Status</dt>
            <dd class="summary">{status.summary || capitalized(status.state)}</dd>
            {status.links.length > 0 ? (
              <>
                <dt>Links</dt>
                <dd>
                  <ul class="links">
                    {status.links.map((link) => (
                      <li>
                        {isWebLink(link.url) ? (
                          <a href={link.url} target="_blank" rel="noreferrer">
                            {link.label}
                          </a>
                        ) : (
                          `${link.label}: ${link.url}`
                        )}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
            {status.blockers.length > 0 ? (
              <>
                <dt>Blocked on</dt>
                <dd>{status.blockers.join(", ")}</dd>
              </>
            ) : null}
            <dt>Updated</dt>
            <dd>
              <Ago at={status.updated_at} />
            </dd>
          </>
        ) : null}
        {agent.created_at_attach ? (
          <>
            <dt>Created</dt>
            <dd>By its own session as it attached</dd>
          </>
        ) : null}
        {agent.closed_at ? (
          <>
            <dt>Closed</dt>
            <dd>
              <Ago at={agent.closed_at} />
            </dd>
          </>
        ) : null}
      </dl>
      <Settled ctx={ctx} />

      <section>
        <h3 class="subsection-title">Asks</h3>
        {model.open.length + model.settled.length === 0 ? <p class="meta">No asks</p> : null}
        {[...model.open, ...model.settled].map((chain) => (
          <AskCard chain={chain} ctx={ctx} back={back} inspecting={agent.id} />
        ))}
      </section>

      <section>
        <h3 class="subsection-title">Messages</h3>
        {messages.length === 0 ? <p class="meta">No messages</p> : null}
        {messages.map((message) => (
          <article class="card">
            <div class="head">
              <p class="card-title">
                {message.from === agent.id ? (
                  <>
                    To <Name id={message.to} ctx={ctx} />
                  </>
                ) : (
                  <>
                    From <Name id={message.from} ctx={ctx} />
                  </>
                )}
              </p>
              <span class="badge kind">{capitalized(message.kind)}</span>
            </div>
            <p class="meta">
              <Ago at={message.sent_at} /> · {readState(message)}
            </p>
            <p class="body">{message.body}</p>
          </article>
        ))}
      </section>

      <section>
        <h3 class="subsection-title">Sessions</h3>
        {sessions.length === 0 ? (
          <p class="meta">No session has attached yet</p>
        ) : (
          <table class="sessions">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Machine</th>
                <th scope="col">Attached</th>
                <th scope="col">Ended</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr>
                  <td>{session.client}</td>
                  <td>{session.machine}</td>
                  <td>
                    <Ago at={session.attached_at} />
                  </td>
                  <td>
                    {session.detached_at === null ? "Attached" : <Ago at={session.detached_at} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {children.length > 0 ? (
        <section>
          <h3 class="subsection-title">Agents under it</h3>
          <ul class="links">
            {children.map((child) => (
              <li>
                <Name id={child.id} ctx={ctx} /> <StateBadge agent={child} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {agent.state === "closed" ? null : <CloseAgent model={model} ctx={ctx} />}
    </>,
  );
}

/** A page with one message, such as being signed out, and the way on from it. */
export function messagePage(heading: string, text: string | undefined, signedOut: boolean) {
  return document(
    `${heading} · agentorg`,
    <>
      <h2 class="section-title">{heading}</h2>
      {text ? <p>{text}</p> : null}
      {signedOut ? (
        <p>
          Run <code>agentorg ui</code> to open this page signed in.
        </p>
      ) : (
        <p>
          <a href="/">Back to the decisions</a>
        </p>
      )}
    </>,
  );
}
