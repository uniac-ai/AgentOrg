import { Actions, Button, Dialog, IconButton, Menu, MenuItem, MoreIcon } from "@agentorg/kit";
import { useState } from "react";
import { type Actor, api, go } from "./data.ts";

/**
 * An agent's menu, in the top bar of its screen: Delete, after asking. Deleting closes the Actor:
 * it stops, its connections and stores go, and so do its views on Home.
 */
export function AgentMenu({ agent }: { agent: Actor }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Menu
        trigger={
          <IconButton label={`${agent.name} options`}>
            <MoreIcon />
          </IconButton>
        }
      >
        <MenuItem onSelect={() => setAsking(true)}>Delete…</MenuItem>
      </Menu>
      {asking && <Confirm agent={agent} onClose={() => setAsking(false)} />}
    </>
  );
}

function Confirm({ agent, onClose }: { agent: Actor; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await api.call("actors", "close", { actorId: agent.actorId });
      go({ screen: "home" });
    } catch (error) {
      setBusy(false);
      setProblem((error as Error).message);
    }
  };
  return (
    <Dialog title={`Delete ${agent.name}?`} onClose={onClose}>
      <p className="quiet confirm-text">
        Its chat and everything it stored go with it. This can't be undone.
      </p>
      {/* Its room kept, so the buttons stay put when it says something. */}
      <p className="err-line" role="alert">
        {problem}
      </p>
      <Actions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          Delete
        </Button>
      </Actions>
    </Dialog>
  );
}
