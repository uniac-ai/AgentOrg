// The chat view's tests in a browser's globals (happy-dom, registered by ./globals.ts before React
// and the kit load), with helpers that run under act().
import "./globals.ts";
import { act } from "react";

/** Let effects and promises settle, under act(). */
export const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

export const click = (element: Element | null | undefined) =>
  act(async () => {
    if (!element) throw new Error("Nothing to click.");
    (element as HTMLElement).click();
  });

export const key = (element: Element, init: KeyboardEventInit) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });

/** Type into a textarea or input as a person does: the value, then an input event React hears. */
export const type = (element: Element, text: string) =>
  act(async () => {
    // The prototype's setter, past React's own on the element, so React sees the value change.
    const field = element as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    if (!setter) throw new Error("Not a field.");
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** An element by role and accessible name (aria-label, or its text). */
export function byRole(role: string, name?: string | RegExp, within: ParentNode = document) {
  const implicit: Record<string, string> = {
    button: "button",
    dialog: "dialog",
    textbox: "textarea",
  };
  const all = [
    ...within.querySelectorAll(`[role="${role}"]${implicit[role] ? `, ${implicit[role]}` : ""}`),
  ];
  const named = all.filter((element) => {
    if (name === undefined) return true;
    const label =
      element.getAttribute("aria-label") ??
      (element.getAttribute("aria-labelledby")
        ? document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent
        : element.textContent) ??
      "";
    return typeof name === "string" ? label.trim() === name : name.test(label);
  });
  return named[0] ?? null;
}
