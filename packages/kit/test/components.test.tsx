// First: the browser globals, before React and the kit load (imports below are sorted).
import "./globals.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";
import {
  Button,
  Dialog,
  ensureKitStyles,
  KIT_CSS,
  Markdown,
  Menu,
  MenuItem,
  Meter,
  Switch,
  Table,
  Tabs,
} from "../src/index.ts";
import { byRole, click, key, render, settle } from "./dom.ts";

test("importing the kit puts its styles first in the document, once", () => {
  const styles = [...document.head.querySelectorAll("style[data-agentorg-kit]")];
  assert.equal(styles.length, 1);
  assert.equal(styles[0]?.textContent, KIT_CSS);
  // A view's own styles come after, and a second call adds nothing.
  const own = document.createElement("style");
  document.head.append(own);
  ensureKitStyles();
  assert.equal(document.head.querySelectorAll("style[data-agentorg-kit]").length, 1);
  assert.equal(document.head.firstElementChild, styles[0]);
  own.remove();
});

const flips: boolean[] = [];
function Flip({ disabled }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="Start it"
      checked={on}
      disabled={disabled}
      onChange={(next) => {
        flips.push(next);
        setOn(next);
      }}
    />
  );
}

test("a switch says its state and flips on a click; a disabled one doesn't", async () => {
  const view = await render(<Flip />);
  const toggle = byRole("switch", "Start it");
  assert.equal(toggle?.getAttribute("aria-checked"), "false");
  await click(toggle);
  assert.equal(toggle?.getAttribute("aria-checked"), "true");
  assert.deepEqual(flips, [true]);
  await view.unmount();

  const off = await render(<Flip disabled />);
  await click(byRole("switch", "Start it"));
  assert.deepEqual(flips, [true]);
  await off.unmount();
});

test("a dialog is named by its title, takes focus, and Escape closes it", async () => {
  let closed = 0;
  const view = await render(
    <Dialog title="New agent" onClose={() => closed++}>
      <input aria-label="Name" />
      <Button variant="primary">Create</Button>
    </Dialog>,
  );
  await settle();
  const dialog = byRole("dialog", "New agent");
  assert.ok(dialog, "a dialog named by its title");
  assert.ok(dialog?.contains(document.activeElement), "focus is inside it");
  await key(dialog as Element, { key: "Escape" });
  assert.equal(closed, 1);
  await view.unmount();
});

test("a menu opens from its trigger, and an item runs and closes it", async () => {
  const ran: string[] = [];
  const view = await render(
    <Menu trigger={<button type="button">Launch options</button>}>
      <MenuItem onSelect={() => ran.push("up")}>Move up</MenuItem>
      <MenuItem disabled onSelect={() => ran.push("never")}>
        Remove
      </MenuItem>
    </Menu>,
  );
  const trigger = byRole("button", "Launch options");
  assert.equal(byRole("menu"), null);
  // Radix opens on pointerdown, as a person's press does, or on Enter from the keyboard.
  await key(trigger as Element, { key: "Enter" });
  await settle();
  assert.ok(byRole("menu"), "open");
  await click(byRole("menuitem", "Remove"));
  assert.deepEqual(ran, [], "a disabled item does nothing");
  await click(byRole("menuitem", "Move up"));
  await settle();
  assert.deepEqual(ran, ["up"]);
  assert.equal(byRole("menu"), null, "closed after");
  await view.unmount();
});

function Settings() {
  const [tab, setTab] = useState<"actors" | "packages">("actors");
  return (
    <Tabs<"actors" | "packages">
      label="Settings"
      tabs={[
        ["actors", "Actors"],
        ["packages", "Packages"],
      ]}
      value={tab}
      onChange={setTab}
    >
      <p>{tab} panel</p>
    </Tabs>
  );
}

test("tabs show the selected one's panel, and a click selects another", async () => {
  const view = await render(<Settings />);
  assert.equal(byRole("tab", "Actors")?.getAttribute("aria-selected"), "true");
  assert.match(byRole("tabpanel")?.textContent ?? "", /actors panel/);
  // Radix selects on mousedown, as a press does.
  await key(byRole("tab", "Actors") as Element, { key: "ArrowRight" });
  await settle();
  assert.equal(byRole("tab", "Packages")?.getAttribute("aria-selected"), "true");
  assert.match(byRole("tabpanel")?.textContent ?? "", /packages panel/);
  await view.unmount();
});

test("a table and a meter draw what they're given", async () => {
  const view = await render(
    <>
      <Table head={["Actor", "State"]} rows={[["Planner", "running"]]} />
      <Meter value={1} max={3} label="1 of 3 done" />
    </>,
  );
  assert.deepEqual(
    [...view.host.querySelectorAll("th, td")].map((cell) => cell.textContent),
    ["Actor", "State", "Planner", "running"],
  );
  assert.deepEqual(
    [...(byRole("img", "1 of 3 done")?.children ?? [])].map((i) => i.className),
    ["kit-on", "", ""],
  );
  await view.unmount();
});

test("markdown renders GitHub's flavor, closes what's still open as it streams, and shows HTML as text", async () => {
  const view = await render(<Markdown text={"Your quest:\n\n**Find the best dump"} />);
  assert.equal(view.host.querySelector("strong")?.textContent, "Find the best dump");
  await view.rerender(
    <Markdown text={"| Quest | Time |\n|---|---|\n| Dumpling crawl | 2 h |\n\n- one\n- ~~two~~"} />,
  );
  assert.deepEqual(
    [...view.host.querySelectorAll("th, td")].map((cell) => cell.textContent),
    ["Quest", "Time", "Dumpling crawl", "2 h"],
  );
  assert.equal(view.host.querySelector("del")?.textContent, "two");
  await view.rerender(<Markdown text={"<img src=x onerror=alert(1)> and <b>bold</b>"} />);
  assert.equal(view.host.querySelector("img, b"), null);
  assert.match(view.host.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
  await view.unmount();
});
