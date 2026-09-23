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
  const entry = new Function("api", `${source}\nconst fn = typeof main === "function" ? main : globalThis.main;
    if (typeof fn !== "function") throw new Error("Application must define main(api)");
    return fn(api);`);
  entry(api);
}

const appImports = new Set([
  "screen", "button", "label", "set_size", "set_pos", "set_text", "on_click", "log",
]);

async function runWasm(bytes: ArrayBuffer, api: AppApi): Promise<void> {
  const module = await WebAssembly.compile(bytes);
  const unsupported = WebAssembly.Module.imports(module)
    .filter((item) => item.module !== "lvw_app" || !appImports.has(item.name))
    .map((item) => `${item.module}.${item.name}`);
  if (unsupported.length) throw new Error(`Unsupported application imports: ${unsupported.join(", ")}`);

  const names = WebAssembly.Module.exports(module).map((item) => item.name);
  const missing = ["memory", "app_abi_version", "app_init", "app_event"]
    .filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Application is missing required exports: ${missing.join(", ")}`);

  const objects = new Map<number, ObjectRef>([[api.screen.handle, api.screen]]);
  let memory: WebAssembly.Memory | undefined;
  let eventCallback: ((id: number, code: number) => void) | undefined;
  const object = (handle: number): ObjectRef => {
    const value = objects.get(handle);
    if (!value) throw new Error(`Unknown application object handle: ${handle}`);
    return value;
  };
  const text = (pointer: number, length: number): string => {
    if (!memory || length < 0 || length > 1_048_576 || pointer < 0 ||
        pointer + length > memory.buffer.byteLength) throw new Error("Invalid application text range");
    return new TextDecoder("utf-8", { fatal: true })
      .decode(new Uint8Array(memory.buffer, pointer, length));
  };
  const create = (kind: "button" | "label", parent: number): number => {
    const value = kind === "button" ? api.runtime.createButton(object(parent))
      : api.runtime.createLabel(object(parent));
    objects.set(value.handle, value);
    return value.handle;
  };
  const instance = await WebAssembly.instantiate(module, {
    lvw_app: {
      screen: () => api.screen.handle,
      button: (parent: number) => create("button", parent),
      label: (parent: number) => create("label", parent),
      set_size: (handle: number, width: number, height: number) => object(handle).setSize(width, height),
      set_pos: (handle: number, x: number, y: number) => object(handle).setPosition(x, y),
      set_text: (handle: number, pointer: number, length: number) => {
        api.runtime.setText(object(handle), text(pointer, length));
        return 0;
      },
      on_click: (handle: number, id: number) => {
        object(handle).on(api.runtime.clickedEvent, (code) => eventCallback?.(id, code));
        return 0;
      },
      log: (pointer: number, length: number) => api.log(text(pointer, length)),
    },
  });
  const exports = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    app_abi_version(): number;
    app_init(): void;
    app_event(id: number, code: number): void;
  };
  memory = exports.memory;
  if (exports.app_abi_version() !== 1) throw new Error("Unsupported application ABI");
  eventCallback = exports.app_event;
  exports.app_init();
}

async function runApplication(app: AppSource, api: AppApi): Promise<void> {
  if (app.kind === "js") {
    runJavaScript(app.source, api);
    return;
  }
  await runWasm(app.bytes, api);
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
