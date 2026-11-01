/** Package-owned contracts projected into explicit Hub feature definitions. */
import {
  type Actor,
  ActorContracts,
  type Form,
  FormContracts,
  type Level,
  type List,
  type Message,
  MessageContracts,
  type Page,
  type Status,
  StatusContracts,
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
export const DIRECTORY = toolDefinition("directory", {
  actor_get: spec<Actor>()(ActorContracts.actor_get),
  actor_list: spec<Page<Actor>>()(ActorContracts.actor_list),
});
export const MESSAGES = toolDefinition("messages", {
  message_send: spec<Message>()(MessageContracts.message_send),
  message_get: spec<Message>()(MessageContracts.message_get),
  message_list: spec<List<Message> & { older: string | null }>()(MessageContracts.message_list),
});
export const WORK = toolDefinition("work", {
  work_create: spec<Work>()(WorkContracts.work_create),
  work_get: spec<Work>()(WorkContracts.work_get),
  work_list: spec<List<Work>>()(WorkContracts.work_list),
  work_update: spec<Work>()(WorkContracts.work_update),
  work_submit: spec<Work>()(WorkContracts.work_submit),
  work_review: spec<Work>()(WorkContracts.work_review),
});
export const FORMS = toolDefinition("forms", {
  form_create: spec<Form>()(FormContracts.form_create),
  form_get: spec<Form>()(FormContracts.form_get),
  form_list: spec<List<Form>>()(FormContracts.form_list),
  form_respond: spec<Form>()(FormContracts.form_respond),
  form_close: spec<Form>()(FormContracts.form_close),
});
export const STATUS = toolDefinition("status", {
  status_set: spec<Status>()(StatusContracts.status_set),
  status_get: spec<Status>()(StatusContracts.status_get),
});
