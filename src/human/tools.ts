/**
 * The human's exposed tools, the calls into the user: `decide`, `note` and `report`, with their
 * schemas. Each runs as an MCP task that completes when the user answers, so a call may wait on the
 * user for hours. A note's output is the empty object, which makes it one-way: its caller does not
 * wait for it.
 */

import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const Label = text(80);
const Words = text(4000);

export const Option = z.strictObject({
  label: Label.describe("The button text; unique within the call."),
  detail: text(300).optional(),
});

export const DecideInput = z
  .strictObject({
    question: text(200).describe("The decision, as a short question."),
    context: text(1000).describe("Two or three sentences for a reader outside the caller's work."),
    options: z.array(Option).min(2).max(6),
    recommendation: Label.describe("The label of the recommended option."),
  })
  .superRefine((input, context) => {
    const labels = input.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "labels must be unique" });
    }
    if (!labels.includes(input.recommendation)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "must be the label of one of the options",
      });
    }
  });

export const DecideOutput = z
  .strictObject({
    choice: Label.nullable().describe("The chosen option's label; null when the user only wrote."),
    words: Words.nullable().describe("The user's own words, quoted."),
  })
  .refine(({ choice, words }) => choice !== null || words !== null, {
    message: "an answer needs a choice, words, or both",
  })
  .meta({
    anyOf: [
      { properties: { choice: { type: "string" } } },
      { properties: { words: { type: "string" } } },
    ],
  });

export const TOOLS = {
  decide: {
    description:
      "Ask the user to decide. The call completes with the user's choice, their words, or both.",
    input: DecideInput,
    output: DecideOutput,
  },
  note: {
    description: "Tell the user something. Nothing comes back; the call completes once it is read.",
    input: z.strictObject({ text: Words }),
    output: z.strictObject({}),
  },
  report: {
    description: "Report an outcome to the user. The call completes once the user acknowledges it.",
    input: z.strictObject({ outcome: Words }),
    output: z.strictObject({ acknowledged: z.literal(true) }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export type InputOf<T extends ToolName> = z.output<(typeof TOOLS)[T]["input"]>;
export type OutputOf<T extends ToolName> = z.output<(typeof TOOLS)[T]["output"]>;

export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOLS, name);

/** The tools as `tools/list` lists them. */
export const TOOL_LIST = Object.entries(TOOLS).map(([name, tool]) => ({
  name,
  description: tool.description,
  inputSchema: schema(tool.input, "input"),
  outputSchema: schema(tool.output, "output"),
  execution: { taskSupport: "required" as const },
}));

function schema(type: z.ZodType, io: "input" | "output") {
  const { $schema: _, ...rest } = z.toJSONSchema(type, { io }) as Record<string, unknown>;
  return rest as { type: "object"; [key: string]: unknown };
}

/**
 * The user's answer to a pending call, as that call's output. A decision's choice must be one of
 * its options; a note or a report needs nothing.
 */
export function answerOf<T extends ToolName>(
  tool: T,
  input: unknown,
  answer: unknown,
): z.ZodSafeParseResult<OutputOf<T>> {
  if (tool !== "decide") {
    return TOOLS[tool].output.safeParse(answer ?? {}) as z.ZodSafeParseResult<OutputOf<T>>;
  }
  const labels = DecideInput.parse(input).options.map((option) => option.label);
  return DecideOutput.refine(({ choice }) => choice === null || labels.includes(choice), {
    path: ["choice"],
    message: "is not one of the options",
  }).safeParse(answer) as z.ZodSafeParseResult<OutputOf<T>>;
}
