// A stand-in check worker for tests: slow to compile or to check when the interface's hash says.
import { parentPort } from "node:worker_threads";

const busy = (ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};
parentPort?.on(
  "message",
  (job: { id: number; parts: { key: string }[]; check?: { key: string } }) => {
    if (job.parts.some((part) => part.key.includes("slowcompile"))) busy(600);
    if (job.check) {
      parentPort?.postMessage({ id: job.id, compiled: true });
      if (job.check.key.includes("slowcheck")) busy(600);
    }
    parentPort?.postMessage({ id: job.id, ok: true });
  },
);
parentPort?.postMessage("ready");
