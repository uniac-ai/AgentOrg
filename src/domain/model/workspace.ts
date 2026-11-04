/** Package-owned contracts projected into explicit Hub feature definitions. */
import {
  type Form,
  type Level,
  type List,
  type Message,
  MessageContracts,
  type Work,
  WorkContracts,
} from "@uniac/agentic-workspace/contracts";
import type { z } from "zod";
import { toolDefinition } from "./json-schema.ts";

// Package descriptors retain input types; exported DTOs supply their response types.
const spec =
  <O>() =>
  <S extends z.ZodType>(definition: {
    level: Level;
    input: S;
    output: z.ZodType;
    description: string;
    writes: boolean;
  }) => ({
    level: definition.level,
    request: definition.input,
    response: definition.output as z.ZodType<O>,
    description: definition.description,
    writes: definition.writes,
  });
export const MESSAGES = toolDefinition("messages", {
  message_send: spec<Message>()(MessageContracts.message_send),
  message_get: spec<Message>()(MessageContracts.message_get),
  message_list: spec<List<Message> & { older: string | null }>()(MessageContracts.message_list),
});
export const WORK = toolDefinition("work", {
  work_create: spec<Work>()(WorkContracts.work_create),
  work_get: spec<Work | Form>()(WorkContracts.work_get),
  work_list: spec<List<Work>>()(WorkContracts.work_list),
  work_update: spec<Work | Form>()(WorkContracts.work_update),
  work_submit: spec<Work>()(WorkContracts.work_submit),
  work_answer: spec<Work | Form>()(WorkContracts.work_answer),
});
