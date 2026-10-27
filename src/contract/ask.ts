/** Asks: questions to the asking agent's manager, which answers them or escalates them. */

import { z } from "zod";
import { Id, LIMITS, Short, Text, Timestamp, Title } from "./common.ts";

export const AskState = z.enum(["open", "answered", "withdrawn"]);
export const AnswerChannel = z.enum(["page", "session", "agent"]);

export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 6;

const Words = z.string().trim().min(1).max(LIMITS.words);

export const Option = z
  .strictObject({
    label: Short.describe("The button text; unique within the ask."),
    detail: z.string().trim().min(1).max(LIMITS.detail).optional(),
  })
  .meta({ id: "Option" });

export const Answer = z
  .strictObject({
    choice: Short.nullable().describe("The label of the chosen option, if one was chosen."),
    words: Words.nullable().describe("The answerer's own words, quoted."),
    by: Id.nullable().describe("The answering agent; null when the user answered."),
    channel: AnswerChannel,
    answered_at: Timestamp,
  })
  .meta({ id: "Answer" });

export const Ask = z
  .strictObject({
    id: Id,
    agent: Id.describe("The asking agent."),
    session: Id.describe("The session that asked."),
    to: Id.nullable().describe("The asking agent's manager; null when it is the user."),
    title: Title,
    context: Text,
    options: z.array(Option),
    recommendation: Short,
    escalates: z
      .array(Id)
      .describe("The asks addressed to the asking agent that this one carries up."),
    state: AskState,
    answer: Answer.nullable(),
    opened_at: Timestamp,
  })
  .meta({ id: "Ask" });

const choiceOrWords = (value: { choice?: string | undefined; words?: string | undefined }) =>
  value.choice !== undefined || value.words !== undefined;

export const AskOpen = z
  .strictObject({
    session: Id.describe("The asking session; the ask goes to its agent's manager."),
    title: Title.describe("The decision, as a short question."),
    context: Text.describe("Two or three sentences for a reader outside the session."),
    options: z.array(Option).min(OPTIONS_MIN).max(OPTIONS_MAX),
    recommendation: Short.describe("The label of the recommended option."),
    escalates: z
      .array(Id)
      .max(OPTIONS_MAX)
      .default([])
      .describe("Open asks addressed to the asking agent that this ask carries up to its manager."),
  })
  .superRefine((ask, context) => {
    const labels = ask.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "labels must be unique" });
    }
    if (!labels.includes(ask.recommendation)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "must be the label of one of the options",
      });
    }
  })
  .meta({ id: "AskOpen" });

export const AskGet = z.strictObject({ ask: Id }).meta({ id: "AskGet" });

export const AskWait = z
  .strictObject({
    ask: Id,
    timeout_seconds: z
      .number()
      .positive()
      .nullable()
      .default(null)
      .describe("Return the ask, still open, after this long; null waits until it is settled."),
  })
  .meta({ id: "AskWait" });

export const AskWithdraw = z
  .strictObject({
    session: Id.describe("A session of the asking agent; only it withdraws the ask."),
    ask: Id,
  })
  .meta({ id: "AskWithdraw" });

export const AskAnswer = z
  .strictObject({
    session: Id.describe("A session of the agent the ask is addressed to."),
    ask: Id,
    choice: Short.optional().describe("The label of the chosen option."),
    words: Words.optional().describe("A note in the answerer's own words."),
  })
  .refine(choiceOrWords, "an answer needs a choice, words, or both")
  .meta({ id: "AskAnswer" });

export const AskRecordAnswer = z
  .strictObject({
    session: Id.describe("A session of the asking agent, in whose conversation the user answered."),
    ask: Id.describe("An ask of that agent addressed to the user."),
    words: Words.describe("The user's words, quoted exactly."),
    choice: Short.optional().describe("The option those words choose, if any."),
  })
  .meta({ id: "AskRecordAnswer" });

export const AskAnswerAsUser = z
  .strictObject({
    ask: Id.describe("Any open ask: addressed to the user, or one the user steps in on."),
    choice: Short.optional(),
    words: Words.optional(),
  })
  .refine(choiceOrWords, "an answer needs a choice, words, or both")
  .meta({ id: "AskAnswerAsUser" });

export const AskList = z
  .strictObject({
    state: AskState.nullable().default("open").describe("Null lists asks in every state."),
  })
  .meta({ id: "AskList" });
