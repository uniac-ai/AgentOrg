/**
 * Evidence: files such as screenshots, attached to a message. The record is part of the contract;
 * the design's phase 2 adds the operation that stores them.
 */

import { z } from "zod";
import { Id, Ref, Short, Timestamp, Title } from "./common.ts";

export const Evidence = z
  .strictObject({
    id: Id,
    message: Id,
    kind: z.enum(["before", "after", "single"]),
    width: z.number().int().positive().nullable().describe("Display width in CSS pixels."),
    caption: Title,
    file: Ref.describe("The stored file's path, relative to the files directory."),
    content_type: Short,
    added_at: Timestamp,
  })
  .meta({ id: "Evidence" });
