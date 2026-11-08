/** The few browser globals copying needs, without the DOM library in the SDK's types. */
interface ClipboardGlobals {
  navigator?: { clipboard?: object };
  document: {
    activeElement: { focus?(): void } | null;
    body: { append(node: unknown): void };
    createElement(tag: "textarea"): {
      value: string;
      style: { cssText: string };
      setAttribute(name: string, value: string): void;
      select(): void;
      remove(): void;
    };
    execCommand(command: "copy"): boolean;
  };
}

/**
 * Make `navigator.clipboard.writeText` work in a frame. A frame's permissions policy blocks the
 * Clipboard API, but the older copy command needs only the person's click, so copying text is the
 * same call in a view as anywhere else. It runs at once, inside that click.
 */
export function installClipboard(self: ClipboardGlobals) {
  const clipboard = self.navigator?.clipboard;
  if (!clipboard) return;
  Object.defineProperty(clipboard, "writeText", {
    configurable: true,
    value: async (text: string) => {
      const { document } = self;
      const focused = document.activeElement;
      const field = document.createElement("textarea");
      field.value = String(text);
      field.setAttribute("aria-hidden", "true");
      field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      focused?.focus?.();
      if (!copied) throw new Error("Copying needs a click.");
    },
  });
}
