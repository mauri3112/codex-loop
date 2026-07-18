import { createApp } from "./app.js";
import type { Server } from "node:http";
import { CodexBridge } from "./codex-bridge.js";
import { JsonWorkflowStore } from "./store.js";
import { RunCoordinator } from "./run-coordinator.js";
import { AttentionSupervisor } from "./attention-supervisor.js";
import { CodexLoopDesigner } from "./loop-designer.js";

const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";

const store = new JsonWorkflowStore();
const bridge = new CodexBridge(store);
const designer = new CodexLoopDesigner(store, bridge);
const coordinator = new RunCoordinator(store, bridge);
const attentionSupervisor = new AttentionSupervisor(store);
let server: Server | undefined;

const start = async () => {
  await bridge.prepareRuntime();
  server = createApp(store, bridge, designer).listen(port, host, () => {
    console.log(`Codex Loop API listening at http://${host}:${port}`);
    coordinator.start();
    attentionSupervisor.start();
  });
};

const closeRuntime = async () => {
  await Promise.allSettled([bridge.close(), designer.close()]);
};

const shutdown = () => {
  coordinator.stop();
  attentionSupervisor.stop();
  if (!server) {
    void closeRuntime().finally(() => process.exit(0));
    return;
  }
  server.close(() => {
    void closeRuntime().finally(() => process.exit(0));
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
void start().catch((error) => {
  console.error("Codex Loop failed to start", error);
  process.exitCode = 1;
});
