import { expect, test } from "bun:test";
import { LvglRuntime, valuesIdentity } from "../bindings/typescript/src/index.ts";
import type { AppApi } from "../toolchains/ts/api.ts";

for (const language of ["c", "cpp", "rust"]) {
  test(`${language} application exports ABI 1 with host-only imports`, async () => {
    const bytes = await Bun.file(`target/apps/${language}/app.wasm`).arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(module);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((item) => item.module === "lvw_app")).toBe(true);
    const exports = WebAssembly.Module.exports(module).map((item) => item.name);
    for (const name of ["memory", "app_abi_version", "app_init", "app_event"]) {
      expect(exports).toContain(name);
    }
  });
}

function javascriptEntry(source: string): (api: AppApi) => void {
  // Keep each uploaded IIFE's global entry separate from the test process.
  return new Function("globalThis", `${source}\nreturn globalThis.main;`)({});
}

test("the built TypeScript application uses the host SDK and releases callbacks with its objects", async () => {
  const source = await Bun.file("target/apps/ts/app.js").text();
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").bytes());
  try {
    const display = runtime.createDisplay(320, 240);
    const screen = runtime.screen(display);
    const pointer = runtime.createPointer(display);
    const messages: unknown[] = [];
    javascriptEntry(source)({ runtime, display, screen, log: (message) => messages.push(message) });
    const raw = runtime.unsafe;
    expect(raw.lv_obj_get_child_count(screen.handle)).toBe(1);
    runtime.step(250);
    const initial = runtime.readFrame(display).rgba;
    const click = (): void => {
      pointer.push(160, 120, true);
      runtime.step(50);
      pointer.push(160, 120, false);
      runtime.step(250);
    };
    click();
    expect(messages).toHaveLength(1);
    expect(runtime.readFrame(display).rgba).not.toEqual(initial);
    click();
    expect(messages).toHaveLength(2);

    raw.lv_obj_delete(raw.lv_obj_get_child(screen.handle, 0));
    click();
    expect(messages).toHaveLength(2);
    expect(raw.lv_obj_get_child_count(screen.handle)).toBe(0);
    display.destroy();
  } finally {
    runtime.shutdown();
  }
});

test.each(["app.js", "samples/png.js", "samples/gif.js", "samples/freetype.js", "samples/tinyttf.js"])("%s values and host identity must agree before any guest access", async (artifact) => {
  const source = await Bun.file(`target/apps/ts/${artifact}`).text();
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").bytes());
  try {
    const identity = runtime.identity;
    const variants: string[] = [];
    for (const hash of [valuesIdentity.wasm_sha256, valuesIdentity.api_sha256]) {
      expect(source.split(hash)).toHaveLength(2);
      variants.push(source.replace(hash, "0".repeat(64)));
    }
    const cases = [
      ...["core-mismatch", "values-mismatch"].map((status) => ({
        source, identity: { ...identity, sdk: { ...identity.sdk, status } },
      })),
      { source, identity: { ...identity, coreSha256: "0".repeat(64) } },
      ...variants.map((source) => ({ source, identity })),
    ];
    for (const item of cases) {
      const api = { runtime: new Proxy({ identity: item.identity }, {
        get(target, key) {
          if (key === "identity") return target.identity;
          throw new Error(`Unexpected runtime access before identity check: ${String(key)}`);
        },
      }) } as AppApi;
      expect(() => javascriptEntry(item.source)(api)).toThrow("TS SDK sample requires matching core and generated values");
    }
  } finally {
    runtime.shutdown();
  }
});
