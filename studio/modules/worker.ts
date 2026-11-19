import { ModuleRuntime } from "./runtime.ts";
import type { ModuleRun, ModuleCommand, ModuleWorkerOutput } from "./protocol.ts";

const scope = self as DedicatedWorkerGlobalScope;
let runtime: ModuleRuntime | undefined;
let started = false;

function send(message: ModuleWorkerOutput, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function frame(): void {
  const value = runtime!.frame();
  if (!value) return;
  send({ type: "frame", width: value.width, height: value.height, frameId: value.frameId,
    pixels: value.rgba.buffer }, [value.rgba.buffer]);
}

function fail(error: unknown, phase: "load" | "runtime"): void {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "error", message, detail: { code: phase === "load" ? "library-load" : "runtime", phase, message } });
}

scope.onmessage = async (event: MessageEvent<({ type: "start" } & ModuleRun) | ModuleCommand>) => {
  const message = event.data;
  try {
    if (message.type === "start") {
      if (started || message.mode !== "modules") throw new Error("A module worker accepts one project");
      started = true;
      runtime = new ModuleRuntime(message.input, message.width, message.height, message.sample === true);
      const inspected = await runtime.inspect();
      send({ type: "module-inspected", ...inspected });
      if (message.operation === "inspect") return;
      if (message.operation !== "run" || !inspected.executable) throw new Error(inspected.reason ?? "Unsupported module operation");
      await runtime.start();
      send({ type: "module-ready", width: message.width, height: message.height, snapshot: runtime.snapshot() });
      frame();
    } else if (message.type === "module-action") {
      if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error("Invalid module command identity");
      const snapshot = runtime!.action(message.action, message.value);
      send({ type: "module-state", id: message.id, snapshot });
      frame();
    } else if (message.type === "module-close") {
      const snapshot = runtime!.close();
      send({ type: "module-closed", snapshot });
      scope.close();
    }
  } catch (error) {
    fail(error, message.type === "start" ? "load" : "runtime");
  }
};
