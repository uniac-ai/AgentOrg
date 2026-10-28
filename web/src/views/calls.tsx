// How a call reads: its mark, a line that says what it is about, who called whom, and how it
// ended. A call into the human reads by its input; a call into any other tool by the tool's name.

import {
  ArrowRightIcon,
  FileTextIcon,
  MessageCircleQuestionIcon,
  SquareFunctionIcon,
  StickyNoteIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CallRecord } from "../../../src/human/types.ts";
import { outputOf } from "../model/activity.ts";
import { SR } from "./marks.tsx";

export type Names = ReadonlyMap<string, string>;

export const nameOf = (id: string, names: Names) => names.get(id) ?? id;

const firstLine = (text: string) => text.split("\n")[0] ?? text;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** What the call is about, in one line: a decision's question, a note, a report's outcome. */
export function callTitle(call: CallRecord): string {
  const words =
    call.tool === "decide"
      ? text(call.input.question)
      : call.tool === "note"
        ? text(call.input.text)
        : call.tool === "report"
          ? text(call.input.outcome)
          : undefined;
  return words ? firstLine(words) : call.tool;
}

const ICONS: Record<string, typeof SquareFunctionIcon> = {
  decide: MessageCircleQuestionIcon,
  note: StickyNoteIcon,
  report: FileTextIcon,
};

export function CallIcon({ call, className }: { call: CallRecord; className?: string }) {
  const Icon = ICONS[call.tool] ?? SquareFunctionIcon;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0",
        call.tool === "decide" ? "text-state-waiting" : "text-muted-foreground",
        className,
      )}
    />
  );
}

/** Who called whom, as "caller → callee". */
export function CallRoute({ call, names }: { call: CallRecord; names: Names }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate">{nameOf(call.from, names)}</span>
      <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
      <SR> called </SR>
      <span className="truncate">{nameOf(call.to, names)}</span>
    </span>
  );
}

/** How a settled call ended, in a few words: the choice made, acknowledged, read, or why not. */
export function outcomeOf(call: CallRecord): string {
  if (call.state === "withdrawn") return "Withdrawn";
  if (call.state === "failed") return call.error ? `Failed: ${call.error}` : "Failed";
  if (call.state === "pending") return "Pending";
  const output = outputOf(call);
  if (call.tool === "decide") return text(output.choice) ?? text(output.words) ?? "Answered";
  if (call.tool === "report") return "Acknowledged";
  if (call.tool === "note") return "Read";
  return "Done";
}
