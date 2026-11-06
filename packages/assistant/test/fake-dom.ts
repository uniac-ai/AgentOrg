/**
 * Just enough of the DOM for the chat view, so its tests run in Node. Like a real one, tag names
 * are upper case, a node has one parent, and `hidden` is a property of its own.
 */
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = {
    values: new Map<string, string>(),
    setProperty(name: string, value: string) {
      this.values.set(name, value);
    },
  };
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  parent: FakeElement | undefined;
  className = "";
  hidden = false;
  value = "";
  rows = 0;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  #text = "";
  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }
  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.#text = text;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.textContent = "";
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  click() {
    this.dispatch("click");
  }
  /** Every element below this one, depth first. */
  *all(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
  find(test: (el: FakeElement) => boolean) {
    return [...this.all()].find(test);
  }
}

export class FakeDocument {
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
}
