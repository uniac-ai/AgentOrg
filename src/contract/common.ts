/** Types shared by every record and request. */

import { z } from "zod";

/** Size caps. The service refuses longer text, which keeps logs out of the record. */
export const LIMITS = {
  id: 64,
  short: 80,
  detail: 300,
  title: 200,
  text: 1000,
  summary: 2000,
  ref: 2000,
  body: 4000,
  words: 4000,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const Id = text(LIMITS.id);
export const Short = text(LIMITS.short);
export const Title = text(LIMITS.title);
export const Text = text(LIMITS.text);
export const Ref = text(LIMITS.ref);
export const Timestamp = z.iso.datetime({ offset: true });

export const ClientKind = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "a lowercase name such as claude-code or codex");

export const Link = z.strictObject({ label: Short, url: Ref }).meta({ id: "Link" });

export const ErrorBody = z
  .strictObject({ code: z.string(), message: z.string() })
  .meta({ id: "ErrorBody", description: "The body of every API error response." });
