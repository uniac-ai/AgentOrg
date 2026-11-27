// A stand-in plugin for tests of which plugins an agent holds.
import type { Context } from "cordis";
import type { AgentPlugin } from "../src/plugins.ts";

/**
 * A plugin that says, in `said`, when it is loaded, with its settings, when its function ran, and
 * when it is unloaded. It gives the model one function, `<name>__do`, while it is loaded.
 */
export const saying = (name: string, said: string[]): AgentPlugin<{ as?: string } | undefined> => ({
  name,
  inject: ["tools"],
  apply(ctx: Context, settings) {
    said.push(`${name} loaded${settings?.as ? ` as ${settings.as}` : ""}`);
    ctx.tools.register({
      name: "do",
      parameters: { type: "object", properties: {} },
      run: async () => {
        said.push(`${name} did`);
        return { output: "Done.", ok: true };
      },
    });
    ctx.effect(() => () => void said.push(`${name} unloaded`));
  },
});
