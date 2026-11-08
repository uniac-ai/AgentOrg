// A test widget as an agent writes one: a view in JSX with the kit's components, built by the Hub
// from React, react-dom and the kit, the packages it allows for views.
import { uiView } from "@agentorg/interfaces";
import { Button, Chat } from "@agentorg/kit";
import { defineWidget } from "@agentorg/sdk";
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Panel() {
  const [count, setCount] = useState(0);
  return (
    <>
      <Button onClick={() => setCount(count + 1)}>Pressed {count}</Button>
      <Chat
        messages={[{ id: "m1", role: "assistant", text: "Hello from the kit" }]}
        running={false}
        onSend={async () => {}}
        onCancel={() => {}}
      />
    </>
  );
}

export default defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el) {
        const root = createRoot(el as Element);
        root.render(<Panel />);
        return () => root.unmount();
      },
    });
  },
});
