import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

/** The most folders one answer names. */
export const FOLDERS_MAX = 2000;
const Path = z.string().min(1).max(4096);

/**
 * `folders@1`: the folders on the machine the app runs on, for a person choosing one. It names
 * folders and nothing else. `list` starts at the person's home folder; `parent` is absent at the
 * top. Refused `unknown` when there's no such folder, `invalid` for a path that isn't absolute.
 */
export const folders = defineInterface({
  name: "folders",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({
      input: z.object({ path: Path.optional() }),
      output: z.object({
        path: Path,
        parent: Path.optional(),
        folders: z.array(z.object({ name: z.string().max(4096) })).max(FOLDERS_MAX),
      }),
    }),
  },
});
