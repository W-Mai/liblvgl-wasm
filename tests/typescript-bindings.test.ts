import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  LvglRuntime, bindingIdentity, LV_COLOR_T_SIZE, LV_PART_MAIN, LV_SYMBOL_OK,
} from "../bindings/typescript/src/index.ts";
import { apiExports, createUnsafeLvglApi } from "../target/typescript/raw.ts";

test("runtime identity is a frozen snapshot of the core and SDK that remains readable after shutdown", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const runtime = await LvglRuntime.load(bytes);
  const custom = await LvglRuntime.load(bytes.slice());
  const identity = runtime.identity;
  try {
    expect(identity).toEqual({
      bridgeAbi: 1,
      coreSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      sdk: {
        status: "matched",
        coreSha256: bindingIdentity.wasm_sha256,
        apiSha256: bindingIdentity.api_sha256,
        verifiedFunctions: bindingIdentity.verified_functions,
      },
    });
    expect(custom.identity).toEqual(identity);
    expect(runtime.identity).toBe(identity);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.sdk)).toBe(true);
    expect(Reflect.set(runtime, "identity", {})).toBe(false);
    expect(Reflect.set(identity, "bridgeAbi", 0)).toBe(false);
    expect(Reflect.set(identity, "sdk", {})).toBe(false);
    expect(Reflect.set(identity.sdk, "status", "core-mismatch")).toBe(false);
    expect(runtime.unsafe.lv_pow(2n, 3)).toBe(8n);
    expect(custom.unsafe.lv_pow(2n, 3)).toBe(8n);
  } finally {
    runtime.shutdown();
    custom.shutdown();
  }
  expect(runtime.identity).toBe(identity);
  expect(custom.identity).toEqual(identity);
  expect(() => runtime.unsafe).toThrow("LVGL runtime is closed");
});

test("generated TypeScript methods cover exactly the supported exports", async () => {
  const report = await Bun.file("target/wasm/api.json").json() as {
    declarations: { name: string; export_name: string | null }[];
  };
  const expected = Object.fromEntries(report.declarations
    .filter((entry) => entry.export_name !== null)
    .map((entry) => [entry.name, entry.export_name]));
  expect(apiExports).toEqual(expected);
  expect(bindingIdentity).toEqual(await Bun.file("target/wasm/api-verification.json").json());
  expect(Object.isFrozen(bindingIdentity)).toBe(true);
  expect(Object.isFrozen(apiExports)).toBe(true);
  const calls: { name: string; args: unknown[] }[] = [];
  const exports = Object.fromEntries(Object.values(apiExports).map((name) => [
    name, (...args: unknown[]) => { calls.push({ name, args }); return 7; },
  ]));
  let guards = 0;
  const raw = createUnsafeLvglApi(exports, () => { guards++; });
  expect(Object.isFrozen(raw)).toBe(true);
  expect(Object.keys(raw).sort()).toEqual(Object.keys(expected).sort());
  for (const name of Object.keys(apiExports) as (keyof typeof apiExports)[]) {
    const call = raw[name] as (...args: (number | bigint)[]) => unknown;
    expect(call(3, 5n)).toBe(7);
    expect(calls.at(-1)).toEqual({ name: apiExports[name], args: [3, 5n] });
  }
  expect(guards).toBe(Object.keys(expected).length);
});

test("generated raw calls use the matching core's objects, memory, and aggregate ABI", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const padded = new Uint8Array(bytes.length + 17);
  padded.set(bytes, 9);
  const view = new DataView(padded.buffer, 9, bytes.length);
  const loading = LvglRuntime.load(view);
  padded.fill(0);
  const runtime = await loading;
  expect(runtime.identity.sdk.status).toBe("matched");
  expect(runtime.identity.coreSha256).toBe(bindingIdentity.wasm_sha256);
  const api = runtime.unsafe;
  const pow = api.lv_pow;
  const allocate = api.lvw_alloc;
  try {
    expect(Object.isFrozen(api)).toBe(true);
    expect(api).toBe(runtime.unsafe);
    expect(pow(18014398509494329n, 1)).toBe(18014398509494329n);
    const display = runtime.createDisplay(80, 60);
    const screen = api.lv_display_get_screen_active(display.handle);
    const button = api.lv_button_create(screen);
    const label = api.lv_label_create(button);
    api.lv_obj_set_size(button, 40, 30);
    api.lv_obj_set_pos(button, 4, 6);
    const color = allocate(LV_COLOR_T_SIZE);
    const text = LV_SYMBOL_OK;
    const textPointer = allocate(text.length);
    expect(color).toBeGreaterThan(0);
    expect(textPointer).toBeGreaterThan(0);
    try {
      api.lv_color_hex(color, 0x123456);
      expect(api.lv_color_to_int(color)).toBe(0x123456);
      api.lv_obj_set_style_bg_color(button, color, LV_PART_MAIN);
      api.lv_obj_get_style_bg_color(color, button, LV_PART_MAIN);
      expect(api.lv_color_to_int(color)).toBe(0x123456);
      new Uint8Array(api.memory.buffer, textPointer, text.length).set(text);
      api.lv_label_set_text(label, textPointer);
      const stored = api.lv_label_get_text(label);
      expect([...new Uint8Array(api.memory.buffer, stored, text.length)]).toEqual([...text]);
      runtime.step(50);
      expect(runtime.readFrame(display).width).toBe(80);
    } finally {
      api.lvw_free(textPointer);
      api.lvw_free(color);
    }
    display.destroy();
  } finally {
    runtime.shutdown();
  }
  expect(() => pow(2n, 3)).toThrow("closed");
  expect(() => allocate(4)).toThrow("closed");
  expect(() => api.memory).toThrow("closed");
  expect(() => runtime.unsafe).toThrow("closed");
});

test("a different core keeps bridge access and rejects generated raw bindings", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const name = new TextEncoder().encode("different-core");
  const section = new Uint8Array([0, name.length + 1, name.length, ...name]);
  const changed = new Uint8Array(bytes.length + section.length);
  changed.set(bytes);
  changed.set(section, bytes.length);
  const runtime = await LvglRuntime.load(changed);
  const identity = runtime.identity;
  try {
    expect(identity.bridgeAbi).toBe(1);
    expect(identity.coreSha256).toBe(new Bun.CryptoHasher("sha256").update(changed).digest("hex"));
    expect(identity.sdk).toEqual({
      status: "core-mismatch",
      coreSha256: bindingIdentity.wasm_sha256,
      apiSha256: bindingIdentity.api_sha256,
      verifiedFunctions: bindingIdentity.verified_functions,
    });
    const display = runtime.createDisplay(80, 60);
    runtime.step(50);
    expect(runtime.readFrame(display).width).toBe(80);
    expect(() => runtime.unsafe).toThrow("bindings do not match");
    display.destroy();
  } finally {
    runtime.shutdown();
  }
  expect(runtime.identity).toBe(identity);
  expect(() => runtime.unsafe).toThrow("LVGL runtime is closed");
});

test("runtime identity and raw access reject mismatched values without affecting bridge access", async () => {
  const valuesPath = fileURLToPath(new URL("../target/typescript/values.ts", import.meta.url));
  const runtimePath = fileURLToPath(new URL("../bindings/typescript/src/index.ts", import.meta.url));
  const corePath = fileURLToPath(new URL("../target/wasm/liblvgl.wasm", import.meta.url));
  for (const field of ["api_sha256", "wasm_sha256"] as const) {
    // Isolate module substitution so other tests retain the real, frozen SDK exports.
    const script = `
      import { mock } from "bun:test";
      import { strict as assert } from "node:assert";
      const original = { ...await import(${JSON.stringify(valuesPath)}) };
      const valuesIdentity = Object.freeze({ ...original.valuesIdentity, ${field}: "0".repeat(64) });
      mock.module(${JSON.stringify(valuesPath)}, () => ({ ...original, valuesIdentity }));
      const { LvglRuntime } = await import(${JSON.stringify(runtimePath)});
      const runtime = await LvglRuntime.load(await Bun.file(${JSON.stringify(corePath)}).bytes());
      assert.equal(runtime.identity.sdk.status, "values-mismatch");
      assert.throws(() => runtime.unsafe, { message: "LVGL constants and layouts do not match these bindings; regenerate the SDK" });
      const display = runtime.createDisplay(32, 24);
      runtime.step(10);
      assert.equal(runtime.readFrame(display).width, 32);
      const identity = runtime.identity;
      runtime.shutdown();
      assert.equal(runtime.identity, identity);
      assert.throws(() => runtime.unsafe, { message: "LVGL runtime is closed" });
      console.log(runtime.identity.sdk.status);
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe("values-mismatch");
  }
});
