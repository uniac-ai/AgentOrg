// The app, put together: the person's gateway, with the programs as its first run and the shell
// this package carries as its frontend.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type Gateway, type GatewayOptions, startGateway } from "./gateway.js";
import {
  closePackageActors,
  type Programs,
  type ProgramsOptions,
  startPrograms,
} from "./programs.js";

export interface AppOptions
  extends Pick<GatewayOptions<Programs>, "home" | "port" | "defaultPort"> {
  /** The frontend's folder; the one this package carries by default, if it carries one. */
  frontend?: string;
  /**
   * How the first run, at each start, logs, reaches ChatGPT and finds a computer service: the
   * app's own by default.
   */
  firstRun?: Pick<ProgramsOptions, "fetch" | "log" | "computer" | "assistant" | "carried">;
}

export type App = Gateway<Programs>;

/** The frontend this package carries, `@agentorg/shell`'s build, when it is installed with it. */
function carriedFrontend(): string | undefined {
  try {
    return join(
      dirname(createRequire(import.meta.url).resolve("@agentorg/shell/package.json")),
      "dist",
    );
  } catch {
    return undefined;
  }
}

/**
 * The app: the gateway, which closes the Actors an earlier release left before the Hub opens and
 * runs the programs beside serving, with the frontend given, else the one this package carries.
 */
export async function startApp(options: AppOptions): Promise<App> {
  const { frontend = carriedFrontend(), firstRun, ...where } = options;
  return startGateway({
    ...where,
    frontend,
    closePackageActors,
    startPrograms: (person, given) => startPrograms(person, { ...given, ...firstRun }),
  });
}
