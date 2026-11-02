import { LvglRuntime, type Display, type ObjectRef, type PointerInput } from "../../bindings/typescript/src/index.ts";
import type { AppApi } from "../../toolchains/ts/api.ts";
import { describeCore, inspectCore } from "./core.ts";
import { createEditorApi, editorModuleSource, type EditorApi } from "./editor-api.ts";
import { FirmwareRuntime } from "./firmware.ts";
import type { AppSource, RunnerError, RunnerInput, RunnerOutput } from "./protocol.ts";

const worker = self as DedicatedWorkerGlobalScope;
let runtime: LvglRuntime | undefined;
let display: Display | undefined;
let pointer: PointerInput | undefined;
let firmware: FirmwareRuntime | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0;
let firmwareFrameId = 0;

function send(message: RunnerOutput, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer);
}

type ErrorWithDetail = Error & { detail?: RunnerError };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetail(error: unknown, code: RunnerError["code"], phase: RunnerError["phase"]): RunnerError {
  const detail = (error as ErrorWithDetail | undefined)?.detail;
  if (detail) return detail;
  return { code, phase, message: errorMessage(error), ...syntaxLocation(error) };
}

function failure(detail: RunnerError): ErrorWithDetail {
  const error = new Error(detail.message) as ErrorWithDetail;
  error.detail = detail;
  return error;
}

function syntaxLocation(error: unknown): Pick<RunnerError, "line" | "column"> {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  const match = text.match(/(?:lvgl-editor\.js|<anonymous>):(\d+)(?::(\d+))?/);
  if (!match) return {};
  return { line: Number(match[1]), ...(match[2] ? { column: Number(match[2]) } : {}) };
}

function fail(error: unknown): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const detail = errorDetail(error, "runtime", "runtime");
  send({ type: "error", message: detail.message, detail });
}

function frame(): void {
  if (!runtime || !display) return;
  const result = runtime.readFrame(display);
  const pixels = result.rgba.buffer as ArrayBuffer;
  send({ type: "frame", width: result.width, height: result.height,
    frameId: result.frameId, pixels }, [pixels]);
}

function firmwareFrame(): void {
  if (!firmware) return;
  const pixels = firmware.frame();
  send({ type: "frame", width: firmware.width, height: firmware.height,
    frameId: ++firmwareFrameId, pixels }, [pixels]);
}

function tick(): void {
  if (!runtime && !firmware) return;
  try {
    const now = performance.now();
    const elapsed = Math.min(100, Math.max(0, Math.round(now - last)));
    last = now;
    let nextMs = 16;
    if (firmware) {
      if (firmware.step(elapsed)) firmwareFrame();
    } else {
      const result = runtime!.step(elapsed);
      if (result.framesChanged) frame();
      nextMs = result.nextMs;
    }
    timer = setTimeout(tick, Math.max(8, Math.min(nextMs || 16, 50)));
  } catch (error) {
    fail(error);
  }
}

async function runJavaScript(source: string, api: AppApi, allowNativeApi?: boolean): Promise<void> {
  const nativeNames = allowNativeApi === true ? Object.keys(api.runtime.unsafe) : [];
  const moduleSource = editorModuleSource(source, nativeNames);
  const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
  let result: unknown;
  try {
    let entry: (api: AppApi | EditorApi) => unknown;
    try {
      const module = await import(url) as { default?: unknown };
      if (typeof module.default !== "function") throw new Error("Application module has no main(api) entry point");
      entry = module.default as (api: AppApi | EditorApi) => unknown;
    } catch (error) {
      const location = syntaxLocation(error);
      throw failure({
        code: "application-syntax",
        phase: "compile",
        message: errorMessage(error),
        ...(location.line ? { line: Math.max(1, location.line - 1), ...(location.column ? { column: location.column } : {}) } : {}),
      });
    }
    try {
      const executionApi = allowNativeApi === undefined ? api : createEditorApi(api, allowNativeApi);
      result = entry(executionApi);
    } catch (error) {
      const detail = errorDetail(error, "application-start", "start");
      throw failure(detail);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    Promise.resolve(result).catch(() => undefined);
    throw failure({
      code: "application-async",
      phase: "start",
      message: "Application main(api) must complete synchronously; return a value instead of a Promise",
    });
  }
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

async function runApplication(app: AppSource, api: AppApi, allowNativeApi?: boolean): Promise<void> {
  if (app.kind === "js") {
    await runJavaScript(app.source, api, allowNativeApi);
    return;
  }
  await runWasm(app.bytes, api);
}

async function start(input: Extract<RunnerInput, { type: "start" }>): Promise<void> {
  let info;
  try {
    if (input.mode === "firmware") {
      firmware = await FirmwareRuntime.load(input.firmware, input.width, input.height);
      firmwareFrameId = 0;
      send({ type: "ready", mode: "firmware", width: input.width, height: input.height, firmware: firmware.report });
      last = performance.now();
      firmwareFrame();
      tick();
      return;
    }
    const preflight = await inspectCore(input.core);
    runtime = await LvglRuntime.load(input.core);
    info = describeCore(runtime.identity, preflight);
  } catch (error) {
    throw failure({ code: "library-load", phase: "load", message: `Library failed to load: ${errorMessage(error)}` });
  }
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
  try {
    if (input.allowNativeApi === true && runtime.identity.sdk.status !== "matched") {
      throw failure({
        code: "unsupported",
        phase: "start",
        message: "Advanced LVGL API requires a core that matches the generated SDK",
      });
    }
    await runApplication(input.app, api, input.allowNativeApi);
  } catch (error) {
    if ((error as ErrorWithDetail | undefined)?.detail) throw error;
    throw failure({ code: "application-start", phase: "start", message: `Application failed to start: ${errorMessage(error)}` });
  }
  send({ type: "ready", mode: "lvgl-app", width: input.width, height: input.height, core: info });
  last = performance.now();
  tick();
}

worker.onmessage = (event: MessageEvent<RunnerInput>) => {
  const message = event.data;
  if (message.type === "start") {
    start(message).catch(fail);
  } else if (message.type === "pointer") {
    try {
      if (firmware) firmware.pointer(message.x, message.y, message.pressed);
      else pointer?.push(message.x, message.y, message.pressed);
    } catch (error) { fail(error); }
  } else if (message.type === "resize") {
    try {
      if (firmware) throw new Error("Firmware resolution is fixed at initialization; restart to resize");
      display?.resize(message.width, message.height);
    } catch (error) { fail(error); }
  } else if (message.type === "stop") {
    if (timer) clearTimeout(timer);
    try { firmware?.shutdown(); } catch { /* Worker termination remains the hard stop. */ }
    worker.close();
  }
};
