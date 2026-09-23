import { LvglRuntime, type Display, type ObjectRef, type PointerInput } from "../../bindings/typescript/src/index.ts";
import { inspectCore } from "./core.ts";
import type { AppSource, RunnerInput, RunnerOutput } from "./protocol.ts";

type AppApi = {
  runtime: LvglRuntime;
  display: Display;
  screen: ObjectRef;
  log(message: unknown): void;
};

const worker = self as DedicatedWorkerGlobalScope;
let runtime: LvglRuntime | undefined;
let display: Display | undefined;
let pointer: PointerInput | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0;

function send(message: RunnerOutput, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer);
}

function fail(error: unknown): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function frame(): void {
  if (!runtime || !display) return;
  const result = runtime.readFrame(display);
  const pixels = result.rgba.buffer as ArrayBuffer;
  send({ type: "frame", width: result.width, height: result.height,
    frameId: result.frameId, pixels }, [pixels]);
}

function tick(): void {
  if (!runtime) return;
  try {
    const now = performance.now();
    const elapsed = Math.min(100, Math.max(0, Math.round(now - last)));
    last = now;
    const result = runtime.step(elapsed);
    if (result.framesChanged) frame();
    timer = setTimeout(tick, Math.max(8, Math.min(result.nextMs || 16, 50)));
  } catch (error) {
    fail(error);
  }
}

function runJavaScript(source: string, api: AppApi): void {
  const entry = new Function("api", `${source}\nreturn typeof main === "function" ? main(api) : globalThis.main?.(api);`);
  const result = entry(api);
  if (result === undefined && !/\bmain\b/.test(source)) {
    throw new Error("Application must define main(api)");
  }
}

async function runApplication(app: AppSource, api: AppApi): Promise<void> {
  if (app.kind === "js") {
    runJavaScript(app.source, api);
    return;
  }
  throw new Error("Wasm application ABI is not available in this build");
}

async function start(input: Extract<RunnerInput, { type: "start" }>): Promise<void> {
  const info = await inspectCore(input.core);
  runtime = await LvglRuntime.load(input.core);
  display = runtime.createDisplay(input.width, input.height);
  pointer = runtime.createPointer(display);
  for (const resource of input.resources) {
    runtime.putResource(resource.name, new Uint8Array(resource.bytes));
  }
  const api: AppApi = {
    runtime,
    display,
    screen: runtime.screen(display),
    log: (message) => send({ type: "log", message: String(message) }),
  };
  await runApplication(input.app, api);
  send({ type: "ready", width: input.width, height: input.height, coreExports: info.exports.length });
  last = performance.now();
  tick();
}

worker.onmessage = (event: MessageEvent<RunnerInput>) => {
  const message = event.data;
  if (message.type === "start") {
    start(message).catch(fail);
  } else if (message.type === "pointer") {
    try { pointer?.push(message.x, message.y, message.pressed); } catch (error) { fail(error); }
  } else if (message.type === "resize") {
    try { display?.resize(message.width, message.height); } catch (error) { fail(error); }
  } else if (message.type === "stop") {
    if (timer) clearTimeout(timer);
    worker.close();
  }
};
