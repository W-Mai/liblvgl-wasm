import type { Display, LvglRuntime, ObjectRef } from "../../bindings/typescript/src/index.ts";
import type { AppApi } from "../../toolchains/ts/api.ts";

type RuntimeMethods = Pick<LvglRuntime,
  | "createButton" | "createLabel" | "createImage"
  | "setText" | "setImageSource" | "putResource"
  | "createTimer" | "cancelTimer"
  | "startAnimation" | "cancelAnimation"
  | "observe" | "observeTarget" | "observeObject" | "cancelObserver"
  | "createImageDecoder" | "cancelImageDecoder"
  | "onEvent" | "deleteObject" | "setObjectSize" | "setObjectPosition"
>;

export type EditorRuntime = RuntimeMethods & Pick<LvglRuntime, "identity" | "clickedEvent" | "deleteEvent" | "eventPointer"> & {
  readonly unsafe: LvglRuntime["unsafe"];
};

export interface EditorApi {
  runtime: EditorRuntime;
  display: Display;
  screen: ObjectRef;
  log(message: unknown): void;
}

const runtimeMethods = [
  "createButton", "createLabel", "createImage",
  "setText", "setImageSource", "putResource",
  "createTimer", "cancelTimer",
  "startAnimation", "cancelAnimation",
  "observe", "observeTarget", "observeObject", "cancelObserver",
  "createImageDecoder", "cancelImageDecoder",
  "onEvent", "deleteObject", "setObjectSize", "setObjectPosition",
] as const satisfies readonly (keyof RuntimeMethods)[];

function nativeApiDisabled(): Error {
  return new Error("Native LVGL API is disabled for this script; enable Advanced LVGL API for a matching core");
}

/** Build a private lexical scope for the selected core's native functions. */
export function editorModuleSource(source: string, nativeNames: readonly string[] = []): string {
  const names = nativeNames.filter((name) => /^lv_[A-Za-z0-9_]+$/.test(name));
  const prefix = names.length ? `const { ${names.join(", ")} } = api.runtime.unsafe; ` : "";
  return [
    `export default function (api) { ${prefix}return (() => {`,
    source,
    '  if (typeof main !== "function" && typeof globalThis.main !== "function") {',
    '    throw new Error("Application must define main(api)");',
    "  }",
    '  return (typeof main === "function" ? main : globalThis.main)(api);',
    "})(); }",
    "//# sourceURL=lvgl-editor.js",
  ].join("\n");
}

export function createEditorApi(api: AppApi, allowNativeApi: boolean): EditorApi {
  const runtime = Object.create(null) as EditorRuntime;
  for (const name of runtimeMethods) {
    Object.defineProperty(runtime, name, {
      enumerable: true,
      value: (...args: unknown[]) => (api.runtime[name] as unknown as (...values: unknown[]) => unknown).apply(api.runtime, args),
    });
  }
  Object.defineProperties(runtime, {
    identity: { enumerable: true, get: () => api.runtime.identity },
    clickedEvent: { enumerable: true, get: () => api.runtime.clickedEvent },
    deleteEvent: { enumerable: true, get: () => api.runtime.deleteEvent },
    eventPointer: {
      enumerable: true,
      get: () => {
        if (!allowNativeApi) throw nativeApiDisabled();
        return api.runtime.eventPointer.bind(api.runtime);
      },
    },
    unsafe: {
      enumerable: true,
      get: () => {
        if (!allowNativeApi) throw nativeApiDisabled();
        return api.runtime.unsafe;
      },
    },
  });
  return Object.freeze({
    runtime: Object.freeze(runtime),
    display: api.display,
    screen: api.screen,
    log: api.log,
  });
}
