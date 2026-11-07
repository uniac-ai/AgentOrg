import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { hubHome } from "../src/person-commands.ts";

const HOME = "/home/someone";

test("the home is --home, else AGENTORG_HUB_HOME, else agentorg in the XDG data folder", () => {
  const xdg = { XDG_DATA_HOME: "/data" };
  // Without XDG_DATA_HOME, ~/.local/share/agentorg, as on macOS too.
  assert.equal(hubHome(undefined, {}, HOME), join(HOME, ".local", "share", "agentorg"));
  // With it, an absolute path, there.
  assert.equal(hubHome(undefined, xdg, HOME), join("/data", "agentorg"));
  // A relative XDG_DATA_HOME is ignored, as the XDG spec says; an empty one is unset.
  assert.equal(
    hubHome(undefined, { XDG_DATA_HOME: "data" }, HOME),
    join(HOME, ".local", "share", "agentorg"),
  );
  assert.equal(
    hubHome(undefined, { XDG_DATA_HOME: "" }, HOME),
    join(HOME, ".local", "share", "agentorg"),
  );
  // AGENTORG_HUB_HOME comes before it, and --home before both, made absolute.
  const both = { ...xdg, AGENTORG_HUB_HOME: "/hub" };
  assert.equal(hubHome(undefined, both, HOME), "/hub");
  assert.equal(hubHome("/flag", both, HOME), "/flag");
  assert.equal(hubHome("rel", both, HOME), resolve("rel"));
});
