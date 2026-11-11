import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareModuleManifests } from "../bindings/typescript/src/module-manifest.ts";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { preflightLvglLabelGraphForConsumer } from "../target/validator/feature-validator.js";

const graphPath = Bun.env.LVW_TEST_LABEL_LIB_GRAPH;
if (!graphPath) throw new Error("LVW_TEST_LABEL_LIB_GRAPH is required");
const source = await Bun.file(graphPath).json() as any[];
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function fixture() {
  const item = structuredClone(source.find((entry) => entry.name === "real"));
  if (!item) throw new Error("missing real label library graph");
  const input = { ...item.input, modules: item.input.modules.map((module: any) => ({ manifest: module.manifest,
    bytes: new Uint8Array(Buffer.from(module.hex, "hex")) })) };
  let calls = 0;
  const options: any = { profile: "lvgl-label-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: { name: "lvw", version: 1 }, abiVersion: 1 },
    label: item.label, modules: item.profile.modules, hosts: item.profile.hosts.map((host: any) => ({ ...host,
      create: () => { calls++; throw new Error("preflight created a host"); } })),
    wasi: { id: "host.wasi", interface: { name: "wasi", version: 1 },
      allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
      outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096,
      clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: () => { calls++; throw new Error("preflight wrote output"); } },
    ...item.profile.limits, allowedFeatures: item.allowedFeatures, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000 };
  return { input, options, calls: () => calls };
}

type Fixture = ReturnType<typeof fixture>;
async function synthetic(name: "middle" | "app", substitutions: Record<string, string>) {
  const directory = await mkdtemp("target/validator/.label-lib-test-");
  try {
    let wat = await readFile(`validator/lvgl-label-lib-${name}.wat`, "utf8");
    const defaults: Record<string, string> = { CORE_IMPORT: '(import "lvcore" "lv_is_initialized" (func (result i32)))',
      MEMORY: '(memory (export "memory") 1 2)', EXTRA: "", EXTRA_IMPORT: "" };
    for (const [key, value] of Object.entries({ ...defaults, ...substitutions })) wat = wat.replaceAll(`@${key}@`, value);
    if (/@[A-Z_]+@/.test(wat)) throw new Error("unexpanded Wasm fixture");
    const watPath = join(directory, "module.wat"), wasmPath = join(directory, "module.wasm");
    await writeFile(watPath, wat);
    const build = Bun.spawnSync(["wasm-tools", "parse", watPath, "-o", wasmPath]);
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    const validate = Bun.spawnSync(["wasm-tools", "validate", "--features=wasm1", wasmPath]);
    if (validate.exitCode !== 0) throw new Error(validate.stderr.toString());
    return new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function replaceModule(fixture: Fixture, id: "middle" | "app", bytes: Uint8Array) {
  const module = fixture.input.modules.find((entry: any) => entry.manifest.id === id);
  const facts = inspectWasmFacts(bytes);
  const type = (item: any) => item.kind === "function" || item.kind === "tag"
    ? { kind: item.kind, ...facts.types[item.typeIndex] } : { kind: item.kind, ...item.type };
  const requirements = new Map<string, any>();
  for (const item of facts.imports) {
    const provider = item.module === "trace" ? "host.trace" : item.module === "lvgl" ? "host.label" : item.module;
    let requirement = requirements.get(provider);
    if (!requirement) { requirement = { provider, interface: item.module, version: 1, imports: [] }; requirements.set(provider, requirement); }
    requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...type(item) });
  }
  module.bytes = bytes;
  module.manifest.artifact.sha256 = facts.sha256;
  module.manifest.requires = [...requirements.values()];
  module.manifest.exports = facts.exports.map((item) => ({ name: item.name, ...type(item) }));
  fixture.options.modules.find((item: any) => item.id === id).sha256 = facts.sha256;
  return facts;
}

test("real label library preflight snapshots the full graph and does not authorize execution", async () => {
  const f = fixture();
  const expected = f.input.modules.map((item: any) => ({ id: item.manifest.id, sha256: hash(item.bytes) }));
  expect(f.input.modules.map((item: any) => item.manifest.id)).toEqual(["app", "middle", "lvcore"]);
  const operation = preflightLvglLabelGraphForConsumer(f.input, f.options);
  f.options.label.consumer = "app";
  f.options.modules.find((item: any) => item.id === "middle").sha256 = "0".repeat(64);
  f.options.allowedFeatures.length = 0;
  f.input.modules.find((item: any) => item.manifest.id === "middle").bytes.fill(0);
  const report = await operation;
  expect(report.consumer).toBe("middle");
  expect(report.graph.order).toEqual(["lvcore", "middle", "app"]);
  expect(report.graph.modules.map(({ id, sha256 }) => ({ id, sha256 }))).toEqual(expected);
  for (const module of report.graph.modules) {
    expect(module.checks.engine).toBe("passed");
    expect(module.checks.hostImplementation).toBe("not-run");
    expect(module.checks.pointerContracts).toBe("not-run");
    expect(module.checks.handleIsolation).toBe("not-run");
    expect(module.checks.environmentIsolation).toBe("not-run");
    expect(module.checks.lifecycle).toBe("not-run");
    expect(module.checks.runtime).toBe("not-run");
  }
  expect(f.calls()).toBe(0);
}, 300_000);

test("consumer identity and graph mismatches fail before host creation", async () => {
  for (const [kind, message] of [["core", "invalid LVGL label consumer"], ["missing", "invalid LVGL label consumer"],
    ["app", "label app must depend on its LVGL core"], ["implicit-app", "label app must depend on its LVGL core"],
    ["sha", "numeric module is not authorized"], ["interface", "interface mismatch"]] as const) {
    const f = fixture();
    if (kind === "core") f.options.label.consumer = "lvcore";
    if (kind === "missing") f.options.label.consumer = "missing";
    if (kind === "app") f.options.label.consumer = "app";
    if (kind === "implicit-app") delete f.options.label.consumer;
    if (kind === "sha") f.options.modules.find((item: any) => item.id === "middle").sha256 = "0".repeat(64);
    if (kind === "interface") f.input.modules.find((item: any) => item.manifest.id === "app").manifest.requires.find((item: any) => item.provider === "middle").version++;
    const operation = preflightLvglLabelGraphForConsumer(f.input, f.options);
    await expect(operation, kind).rejects.toThrow(message);
    expect(f.calls(), kind).toBe(0);
  }
}, 300_000);

test("matched Wasm bytes reject missing memory and dependencies and host spoofing", async () => {
  const cases = [
    { name: "memory", module: "middle", substitutions: { MEMORY: "(memory 1 2)" }, message: "label profile requires owned exported memory" },
    { name: "dependency", module: "middle", substitutions: { CORE_IMPORT: "" }, message: "label consumer must depend on its LVGL core" },
    { name: "host-spoof", module: "app", substitutions: { EXTRA_IMPORT: '(import "lvgl" "lv_screen_active" (func (result i32)))' }, message: "LVGL label host is reserved for its consumer" },
  ] as const;
  for (const item of cases) {
    const f = fixture();
    replaceModule(f, item.module, await synthetic(item.module, item.substitutions));
    expect(() => prepareModuleManifests(f.input), item.name).not.toThrow();
    await expect(preflightLvglLabelGraphForConsumer(f.input, f.options), item.name).rejects.toThrow(item.message);
    expect(f.calls(), item.name).toBe(0);
  }
}, 300_000);

test("label imports cannot be exposed as renamed numeric business exports", async () => {
  for (const [target, signature] of [["screen", { name: "renamed", params: [], results: ["i32"] }],
    ["create", { name: "renamed", params: ["i32"], results: ["i32"] }]] as const) {
    const f = fixture();
    const facts = replaceModule(f, "middle", await synthetic("middle", { EXTRA: `(export "renamed" (func $${target}))` }));
    f.options.modules.find((item: any) => item.id === "middle").exports.push(signature);
    const imported = facts.imports.find((item) => item.module === "lvgl" && item.name === (target === "screen" ? "lv_screen_active" : "lv_label_create"))!;
    const exported = facts.exports.find((item) => item.name === "renamed")!;
    expect(imported.kind).toBe("function"); expect(exported.kind).toBe("function");
    expect(exported.index).toBe(imported.index);
    expect(() => prepareModuleManifests(f.input)).not.toThrow();
    await expect(preflightLvglLabelGraphForConsumer(f.input, f.options)).rejects.toThrow('"middle": LVGL label imports cannot be re-exported');
    expect(f.calls()).toBe(0);
  }
  const unlisted = fixture();
  replaceModule(unlisted, "middle", await synthetic("middle", { EXTRA: '(export "renamed" (func $screen))' }));
  expect(() => prepareModuleManifests(unlisted.input)).not.toThrow();
  await expect(preflightLvglLabelGraphForConsumer(unlisted.input, unlisted.options)).rejects.toThrow("LVGL label imports cannot be re-exported");
  expect(unlisted.calls()).toBe(0);
  const f = fixture();
  const facts = replaceModule(f, "middle", await synthetic("middle", { EXTRA: '(func (export "renamed") (result i32) i32.const 1)' }));
  f.options.modules.find((item: any) => item.id === "middle").exports.push({ name: "renamed", params: [], results: ["i32"] });
  const exported = facts.exports.find((item) => item.name === "renamed")!;
  expect(facts.functions[exported.index]!.imported).toBe(false);
  expect((await preflightLvglLabelGraphForConsumer(f.input, f.options)).consumer).toBe("middle");
  expect(f.calls()).toBe(0);
}, 300_000);
