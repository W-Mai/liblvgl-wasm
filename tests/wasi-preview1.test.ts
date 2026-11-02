import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { inspectWasiPreview1, WASI_PREVIEW1_IMPORT_NAMES } from "../bindings/typescript/src/index.ts";
import { createWasiImports, WASI_IMPORT_NAMES } from "../bindings/typescript/src/wasi.ts";

const leb = (value: number): number[] => {
  const bytes: number[] = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 0x80 : 0)); } while (value);
  return bytes;
};
const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
const vec = (...entries: number[][]): number[] => [...leb(entries.length), ...entries.flat()];
const section = (id: number, bytes: number[]): number[] => [id, ...leb(bytes.length), ...bytes];
const wasm = (...sections: number[][]): Uint8Array => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const fn = (params: number[], results: number[]): number[] => [0x60, ...leb(params.length), ...params, ...leb(results.length), ...results];
const imported = (module: string, name: string, kind: number, ...type: number[]): number[] => [...text(module), ...text(name), kind, ...type];
const exported = (name: string, kind: number, index: number): number[] => [...text(name), kind, ...leb(index)];
const i32 = 0x7f, i64 = 0x7e;
const namespace = "wasi_snapshot_preview1";

test("SDK 34 links the 45 declared WASI functions with their actual raw import signatures", async () => {
  const sdkProcess = Bun.spawn(["sh", "scripts/resolve-wasi-sdk.sh", process.cwd()], { stdout: "pipe", stderr: "pipe" });
  const [sdkStatus, sdkOutput, sdkError] = await Promise.all([
    sdkProcess.exited, new Response(sdkProcess.stdout).text(), new Response(sdkProcess.stderr).text(),
  ]);
  expect(sdkStatus, sdkError).toBe(0);
  const directory = await mkdtemp(resolve("target", "wasi-preview1-test-"));
  try {
    const output = resolve(directory, "preview1.wasm");
    const compiler = Bun.spawn([
      resolve(sdkOutput.trim(), "bin/clang"), "--target=wasm32-wasip1", "-std=c11", "-O0", "-Werror",
      "-Wl,--no-entry", "-Wl,--export-memory", "tests/fixtures/wasi/preview1-imports.c", "-o", output,
    ], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      compiler.exited, new Response(compiler.stdout).text(), new Response(compiler.stderr).text(),
    ]);
    expect(status, stdout + stderr).toBe(0);
    const bytes = await Bun.file(output).arrayBuffer();
    const report = inspectWasiPreview1(bytes);
    expect(report.evidence).toBe("present");
    expect(report.imports.length).toBe(45);
    expect(new Set(report.imports)).toEqual(new Set(WASI_PREVIEW1_IMPORT_NAMES.filter((name) => name !== "proc_raise")));
    expect(report.checks).toEqual({ importSignatures: "passed", engine: "passed", targetProvenance: "not-run",
      feature: "not-run", hostImplementation: "not-run", runtime: "not-run" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("proc_raise and valid Preview 1 functions do not depend on the current browser host subset", () => {
  const bytes = wasm(
    section(1, vec(fn([i32], [i32]), fn([i32, i32], [i32]))),
    section(2, vec(imported(namespace, "proc_raise", 0, 0), imported(namespace, "random_get", 0, 1), imported(namespace, "proc_raise", 0, 0))),
  );
  expect(WebAssembly.validate(bytes)).toBe(true);
  const report = inspectWasiPreview1(bytes);
  expect(WASI_PREVIEW1_IMPORT_NAMES.length).toBe(46);
  expect(report.evidence).toBe("present");
  expect(report.imports).toEqual(["proc_raise", "random_get", "proc_raise"]);
});

test("browser host capabilities remain a separate subset of the Preview 1 ABI", () => {
  const host = createWasiImports(() => undefined);
  expect([...WASI_IMPORT_NAMES].sort()).toEqual(Object.keys(host).sort());
  expect(WASI_IMPORT_NAMES.every((name) => WASI_PREVIEW1_IMPORT_NAMES.includes(name))).toBe(true);
  expect(WASI_PREVIEW1_IMPORT_NAMES).toContain("random_get");
  expect(Object.keys(host)).not.toContain("random_get");
});

test("rejects unknown names, non-functions and incorrect Preview 1 signatures", () => {
  const checks = [
    [wasm(section(2, vec(imported(namespace, "fd_close", 3, i32, 0)))), "must be a function"],
    [wasm(section(1, vec(fn([], []))), section(2, vec(imported(namespace, "__proto__", 0, 0)))), "unsupported WASI Preview 1 import"],
    [wasm(section(1, vec(fn([i32, i32, i32], [i32]))), section(2, vec(imported(namespace, "clock_time_get", 0, 0)))), "signature mismatch"],
    [wasm(section(1, vec(fn([i32], [i32]))), section(2, vec(imported(namespace, "proc_exit", 0, 0)))), "signature mismatch"],
  ] as const;
  for (const [bytes, reason] of checks) {
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(() => inspectWasiPreview1(bytes)).toThrow(reason);
  }
});

test("reuses signatures across repeated imports and bounds oversized type declarations", () => {
  const repeated = new Array(10_000).fill(null).map(() => imported(namespace, "fd_close", 0, 0));
  const valid = wasm(section(1, vec(fn([i32], [i32]))), section(2, vec(...repeated)));
  expect(WebAssembly.validate(valid)).toBe(true);
  expect(inspectWasiPreview1(valid).imports.length).toBe(10_000);
  const oversized = wasm(section(1, vec(fn(new Array(50_001).fill(i32), []))));
  expect(() => inspectWasiPreview1(oversized)).toThrow("inspection limit: vector elements");
  const largeType = wasm(section(1, vec(fn(new Array(10_000).fill(i32), []))),
    section(2, vec(...new Array(10_000).fill(null).map(() => imported(namespace, "fd_close", 0, 0)))));
  expect(() => inspectWasiPreview1(largeType)).toThrow("signature mismatch");
});

test("rejects non-Preview 1 namespaces without rejecting ordinary custom namespaces", () => {
  for (const module of ["wasi_unstable", "wasi:cli/environment@0.2.0"]) {
    const bytes = wasm(section(1, vec(fn([], []))), section(2, vec(imported(module, "f", 0, 0))));
    expect(() => inspectWasiPreview1(bytes)).toThrow("unsupported WASI import namespace");
  }
  for (const module of ["wasi_custom", "wasi", "WASI", "my.wasi:foo"]) {
    const bytes = wasm(section(1, vec(fn([], []))), section(2, vec(imported(module, "f", 0, 0))));
    expect(inspectWasiPreview1(bytes).evidence).toBe("absent");
  }
});

test("absence of WASI imports is not reported as proof of a target ABI", () => {
  const bytes = wasm();
  const report = inspectWasiPreview1(bytes);
  expect(report.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(report.evidence).toBe("absent");
  expect(report.imports).toEqual([]);
  expect(report.checks).toEqual({ importSignatures: "not-observed", engine: "passed", targetProvenance: "not-run",
    feature: "not-run", hostImplementation: "not-run", runtime: "not-run" });
});

test("entrypoints have no parameters or results and validation never executes start", () => {
  for (const name of ["_initialize", "_start"]) {
    const good = wasm(section(1, vec(fn([], []))), section(3, vec([0])), section(7, vec(exported(name, 0, 0))), section(10, vec([2, 0, 0x0b])));
    const report = inspectWasiPreview1(good);
    expect(name === "_initialize" ? report.entrypoints.initialize : report.entrypoints.start).toBe(true);
    const wrong = wasm(section(1, vec(fn([i32], []))), section(3, vec([0])), section(7, vec(exported(name, 0, 0))), section(10, vec([2, 0, 0x0b])));
    expect(WebAssembly.validate(wrong)).toBe(true);
    expect(() => inspectWasiPreview1(wrong)).toThrow("must be a () -> () function");
    const global = wasm(section(6, vec([i32, 0, 0x41, 0, 0x0b])), section(7, vec(exported(name, 3, 0))));
    expect(() => inspectWasiPreview1(global)).toThrow("must be a () -> () function");
  }
  const trap = wasm(section(1, vec(fn([], []))), section(3, vec([0])), section(8, [0]), section(10, vec([3, 0, 0x00, 0x0b])));
  expect(WebAssembly.validate(trap)).toBe(true);
  expect(inspectWasiPreview1(trap).entrypoints.startSection).toBe(true);
  expect(() => new WebAssembly.Instance(new WebAssembly.Module(trap))).toThrow();
});

test("validates actual code and uses the underlying snapshot rather than shadowed view properties", () => {
  const invalid = wasm(section(1, vec(fn([], []))), section(3, vec([0])), section(10, vec([2, 0, 0])));
  expect(() => inspectWasiPreview1(invalid)).toThrow("current engine compilation failed");
  const bytes = wasm();
  const backing = new Uint8Array(bytes.length + 4);
  backing.set(bytes, 2);
  const view = backing.subarray(2, -2);
  Object.defineProperty(view, "buffer", { value: invalid.buffer });
  expect(inspectWasiPreview1(view).sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
});
