/** Which of the Hub's interfaces a session at an organization level presents. */
import { Level, type ToolDescriptor } from "../../domain/model/index.ts";

/** Whether an interface tagged `tag` is presented at `level`; each level contains the one before. */
const presents = (level: Level | undefined, tag: Level | undefined) =>
  level === undefined ||
  (tag !== undefined && Level.options.indexOf(tag) <= Level.options.indexOf(level));

/** The Hub's offers a session at `level` presents; without a level, all of them. */
export const presented = (tools: ToolDescriptor[], level: Level | undefined) =>
  tools.flatMap((tool) => tool.interfaces.filter((offer) => presents(level, offer.level)));
