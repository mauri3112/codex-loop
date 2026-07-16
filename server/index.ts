import { createApp } from "./app.js";
import { CodexBridge } from "./codex-bridge.js";
import { JsonWorkflowStore } from "./store.js";
import { RunCoordinator } from "./run-coordinator.js";

const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";

const store = new JsonWorkflowStore();
const bridge = new CodexBridge(store);
const coordinator = new RunCoordinator(store, bridge);
const server = createApp(store, bridge).listen(port, host, () => {
  console.log(`Codex Loop API listening at http://${host}:${port}`);
  coordinator.start();
});

const shutdown = () => {
  coordinator.stop();
  server.close(() => {
    void bridge.close().finally(() => process.exit(0));
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
