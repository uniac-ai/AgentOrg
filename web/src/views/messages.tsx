// How a question or a message reads, wherever it shows: who sent it and to whom, its words and
// links, and for a question its options as buttons, the recommended one filled and starred. A
// question takes a choice at once, or an answer in words; a message takes a reply or a read.

import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  ReplyIcon,
  SendIcon,
  ShieldCheckIcon,
  StarIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { LinkRecord, MessageRecord, QuestionRecord } from "../../../src/clients/web/types.ts";
import type { Member } from "../model/organization.ts";
import { SR, StateMark, StateName } from "./marks.tsx";
import { Ago } from "./time.tsx";

/** Each actor's name by id, the user's as "you". */
export type Names = ReadonlyMap<string, string>;

export const nameOf = (id: string, names: Names) => names.get(id) ?? id;

/** A message's first line, which says what it is about. */
export const firstLine = (text: string) => text.split("\n")[0] ?? text;

/** An actor, by name, linked to its page; the user reads as "you" and links nowhere. */
export function ActorName({
  id,
  names,
  member,
  className,
}: {
  id: string;
  names: Names;
  member: Member | undefined;
  className?: string;
}) {
  if (member === undefined || member.manager === null) {
    return <span className={className}>{nameOf(id, names)}</span>;
  }
  return (
    <Link
      to="/people/$actorId"
      params={{ actorId: id }}
      className={cn("inline-flex min-w-0 items-center gap-1.5 hover:underline", className)}
    >
      <StateMark member={member} />
      <span className="truncate">{nameOf(id, names)}</span>
      <StateName member={member} />
    </Link>
  );
}

/** The links a record carries, by title, else by address. */
export function Links({ links, className }: { links: readonly LinkRecord[]; className?: string }) {
  if (links.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {links.map((link) => (
        <li key={link.url} className="min-w-0 max-w-full">
          <Badge
            variant="outline"
            render={<a href={link.url} target="_blank" rel="noreferrer" />}
            className="max-w-full min-w-0 sm:max-w-72"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{link.title ?? link.url.replace(/^https?:\/\//, "")}</span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** A message's words: the first line leads, the rest follows in full. */
export function Words({ text }: { text: string }) {
  const [lead, ...rest] = text.split("\n");
  return (
    <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
      <p className="font-medium">{lead}</p>
      {rest.join("\n").trim() ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {rest.join("\n").trim()}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A question's options as buttons. Each answers at once, except on an approval, where a press
 * picks the option, filled, for a Send to confirm. Options with details stack.
 */
function Options({
  question,
  picked,
  onPress,
  busy,
}: {
  question: QuestionRecord;
  /** The option picked on an approval; undefined where a press answers at once. */
  picked: string | null | undefined;
  onPress: (label: string) => void;
  busy: boolean;
}) {
  const stacked = question.options.some((option) => option.detail);
  const picking = picked !== undefined;
  return (
    <div className={cn("flex gap-2", stacked ? "flex-col" : "flex-wrap")}>
      {question.options.map((option, index) => {
        const recommended = option.label === question.recommendation;
        const filled = picking ? option.label === picked : recommended;
        return (
          <Button
            key={option.label}
            type="button"
            variant={filled ? "default" : "outline"}
            aria-pressed={picking ? filled : undefined}
            disabled={busy}
            onClick={() => onPress(option.label)}
            className={cn(
              "h-auto min-h-8 min-w-0 max-w-full text-left whitespace-normal",
              stacked && "justify-start py-2",
            )}
          >
            {recommended ? <StarIcon aria-hidden="true" className="fill-current" /> : null}
            <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
              <span>
                {option.label}
                {recommended ? <SR>, recommended</SR> : null}
              </span>
              {option.detail ? (
                <span className="text-xs font-normal opacity-80">{option.detail}</span>
              ) : null}
            </span>
            <span
              aria-hidden="true"
              className="hidden font-mono text-[0.65rem] font-normal opacity-60 sm:inline"
            >
              {index + 1}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/** The parties and time of a question or message. */
function RecordHeader({
  lead,
  from,
  to,
  marks,
  at,
  names,
}: {
  /** The mark leading its header: a checkbox where it can join an answer, else its icon. */
  lead: React.ReactNode;
  from: { id: string; member: Member | undefined };
  /** The addressee, shown when it is not the user. */
  to: { id: string; member: Member | undefined } | undefined;
  marks: React.ReactNode;
  at: string;
  names: Names;
}) {
  return (
    <CardHeader className="flex min-w-0 flex-row items-center gap-2 text-sm text-muted-foreground">
      {lead}
      <ActorName
        id={from.id}
        names={names}
        member={from.member}
        className="font-medium text-foreground"
      />
      {to ? (
        <>
          <SR>to</SR>
          <span aria-hidden="true">→</span>
          <ActorName id={to.id} names={names} member={to.member} />
        </>
      ) : null}
      {marks}
      <Ago at={at} className="ml-auto shrink-0 text-xs tabular-nums" />
    </CardHeader>
  );
}

export interface QuestionCardModel {
  question: QuestionRecord;
  from: Member | undefined;
  /** The addressee, when it is not the user. */
  to: Member | undefined;
  names: Names;
  /** Its answerer: only the user, or only another actor besides the user. */
  approver: "you" | "other" | undefined;
  /** Whether it is in the answer being written; undefined where answers take one at a time. */
  selected: boolean | undefined;
  busy: boolean;
  onSelect: (selected: boolean) => void;
  /** Answering it with an option: at once, or for an approval, once the pick is sent. */
  onChoose: (label: string) => void;
  /** The option picked on an approval, null for none yet; undefined for any other question. */
  picked: string | null | undefined;
  onPick: (label: string) => void;
  /** Answering it in words, in the composer. */
  onAnswer: () => void;
}

/** A question, with its options as buttons and an answer in words. */
export function QuestionCard(model: QuestionCardModel) {
  const { question, names } = model;
  return (
    <Card
      data-row={question.id}
      tabIndex={0}
      role="article"
      aria-label={`Question from ${nameOf(question.from, names)}: ${firstLine(question.text)}`}
      className={cn(
        "shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        model.approver === "you" && "ring-state-review/50",
        model.selected && "bg-muted/40 ring-primary/60",
      )}
    >
      <RecordHeader
        lead={
          model.selected === undefined ? (
            <MessageCircleQuestionIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-state-waiting"
            />
          ) : (
            <Checkbox
              checked={model.selected}
              onCheckedChange={(checked) => model.onSelect(checked)}
              aria-label="In the answer"
            />
          )
        }
        from={{ id: question.from, member: model.from }}
        to={model.to && { id: question.to, member: model.to }}
        marks={
          <>
            {question.cause !== null ? (
              <span title="Carried up" className="inline-flex">
                <CornerLeftUpIcon aria-hidden="true" className="size-3.5" />
                <SR>, carried up</SR>
              </span>
            ) : null}
            {model.approver ? (
              <span
                title={model.approver === "you" ? "Approval: yours alone" : "Approval"}
                className={cn("inline-flex", model.approver === "you" && "text-state-review")}
              >
                <ShieldCheckIcon aria-hidden="true" className="size-3.5" />
                <SR>
                  {model.approver === "you" ? ", an approval only you give" : ", an approval"}
                </SR>
              </span>
            ) : null}
          </>
        }
        at={question.created_at}
        names={names}
      />
      <CardContent className="flex flex-col gap-3">
        <Words text={question.text} />
        <Links links={question.links} />
        {question.options.length > 0 ? (
          <Options
            question={question}
            picked={model.picked}
            onPress={model.picked === undefined ? model.onChoose : model.onPick}
            busy={model.busy}
          />
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-1 py-2">
        {model.picked !== undefined && question.options.length > 0 ? (
          <Button
            type="button"
            size="sm"
            disabled={model.picked === null || model.busy}
            onClick={() => model.picked && model.onChoose(model.picked)}
            className="mr-1"
          >
            <SendIcon aria-hidden="true" />
            Send
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={model.onAnswer}>
          <ReplyIcon aria-hidden="true" />
          Answer
        </Button>
      </CardFooter>
    </Card>
  );
}

export interface MessageCardModel {
  message: MessageRecord;
  from: Member | undefined;
  names: Names;
  busy: boolean;
  onReply: () => void;
  onRead: () => void;
}

/** A message to the user, which the user replies to or marks read. */
export function MessageCard(model: MessageCardModel) {
  const { message, names } = model;
  return (
    <Card
      data-row={message.id}
      tabIndex={0}
      role="article"
      aria-label={`Message from ${nameOf(message.from, names)}: ${firstLine(message.text)}`}
      className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RecordHeader
        lead={<MessageSquareIcon aria-hidden="true" className="size-4 shrink-0" />}
        from={{ id: message.from, member: model.from }}
        to={undefined}
        marks={null}
        at={message.created_at}
        names={names}
      />
      <CardContent className="flex flex-col gap-3">
        <Words text={message.text} />
        <Links links={message.links} />
      </CardContent>
      <CardFooter className="flex-wrap gap-1 py-2">
        <Button variant="ghost" size="sm" onClick={model.onReply}>
          <ReplyIcon aria-hidden="true" />
          Reply
        </Button>
        <Button variant="ghost" size="sm" onClick={model.onRead} disabled={model.busy}>
          <CheckIcon aria-hidden="true" />
          Mark read
        </Button>
      </CardFooter>
    </Card>
  );
}
