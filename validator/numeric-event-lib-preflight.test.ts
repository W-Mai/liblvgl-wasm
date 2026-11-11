import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareModuleManifests } from "../bindings/typescript/src/module-manifest.ts";
import { compileNumericModules, instantiateNumericEnvironment, prepareNumericProfile } from "../bindings/typescript/src/numeric-environment.ts";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { exerciseEventConsumer } from "../tests/fixtures/feature-sdk/event-consumer.ts";
const featureValidator: typeof import("../target/validator/feature-validator.js") =
  await import(Bun.env.LVW_TEST_FEATURE_VALIDATOR ?? "../target/validator/feature-validator.js");

test("official C library owns its table and dispatcher in the real three-module graph", async () => {
  const bytes = await Bun.file(Bun.env.LVW_TEST_EVENT_LIB_GRAPH!).arrayBuffer();
  const cases = JSON.parse(new TextDecoder().decode(bytes));
  for (const item of cases) {
    const middle = item.input.modules.find((module: any) => module.manifest.id === "middle");
    const app = item.input.modules.find((module: any) => module.manifest.id === "app");
    const facts = inspectWasmFacts(Buffer.from(middle.hex, "hex"));
    const dispatcher = facts.exports.find((value) => value.name === "app_event_dispatch");
    expect(dispatcher?.kind).toBe("function");
    if (dispatcher?.kind !== "function") throw new Error("missing dispatcher");
    expect(facts.functions[dispatcher.index]?.imported).toBe(false);
    expect(facts.types[dispatcher.typeIndex]).toEqual({ params: ["i32", "i32"], results: [] });
    expect(facts.tables).toHaveLength(1);
    expect(facts.tables[0]!.imported).toBe(false);
    expect(facts.tables[0]!.type.maximum).not.toBeNull();
    expect(inspectWasmFacts(Buffer.from(app.hex, "hex")).imports.every((value) => value.module !== "lvgl")).toBe(true);
    const result = await exerciseEventConsumer(new TextEncoder().encode(JSON.stringify([{ ...item, name: "real" }])).buffer, featureValidator);
    expect(result).toEqual({ consumer: "middle", order: ["lvcore", "middle", "app"], modules: 3,
      runtime: ["not-run", "not-run", "not-run"], hostCalls: 0, loaderRejected: true });
  }
}, 300_000);

const directory = "target/validator/lvgl-event-negative";
const mainWat = `(module
  (memory (export "memory") 1 2)
  (func (export "module_init") (result i32) i32.const 0)
  (func (export "module_close") (result i32) i32.const 0)
  (func (export "app_run") (param i32) (result i32) local.get 0))`;
const emptyConsumerWat = `(module
  (memory (export "memory") 1 2)
  (table 1 1 funcref)
  (func (export "module_init") (result i32) i32.const 0)
  (func (export "module_close") (result i32) i32.const 0)
  (func (export "app_event_dispatch") (param i32 i32)))`;

async function compile(wat: string): Promise<Uint8Array> {
  const path = await mkdtemp("target/validator/.event-lib-preflight-");
  try {
    const source = join(path, "module.wat"), output = join(path, "module.wasm");
    await writeFile(source, wat);
    const parsed = Bun.spawnSync(["wasm-tools", "parse", source, "-o", output]);
    if (parsed.exitCode !== 0) throw new Error(parsed.stderr.toString());
    const validated = Bun.spawnSync(["wasm-tools", "validate", output]);
    if (validated.exitCode !== 0) throw new Error(validated.stderr.toString());
    return new Uint8Array(await Bun.file(output).arrayBuffer());
  } finally { await rm(path, { recursive: true, force: true }); }
}

async function fixture(middleName = "app", appBytes?: Uint8Array, middleBytes?: Uint8Array) {
  const inputs = await Promise.all([
    ["app", appBytes ? Promise.resolve(appBytes) : compile(mainWat)],
    ["middle", middleBytes ? Promise.resolve(middleBytes) : Bun.file(`${directory}/${middleName}.wasm`).bytes()],
    ["lvcore", Bun.file(`${directory}/core.wasm`).bytes()],
  ].map(async ([id, bytes]) => ({ id: id as string, bytes: await bytes as Uint8Array })));
  const interfaces = (name: string) => ({ name, version: 1 });
  const hosts = new Map<string, any[]>();
  const modules = inputs.map(({ id, bytes }) => {
    const facts = inspectWasmFacts(bytes);
    const descriptor = (item: any) => item.kind === "function" || item.kind === "tag"
      ? { kind: item.kind, ...facts.types[item.typeIndex] } : { kind: item.kind, ...item.type };
    const requirements = new Map<string, any>();
    for (const item of facts.imports) {
      const provider = item.module === "trace" ? "host.trace" : item.module === "lvw" ? "host.lvw"
        : item.module === "middle" ? "middle" : "host.label";
      const iface = provider === "host.label" ? "lvgl" : provider === "middle" ? "middle" : provider.slice(5);
      let requirement = requirements.get(provider);
      if (!requirement) { requirement = { provider, interface: iface, version: 1, imports: [] }; requirements.set(provider, requirement); }
      requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...descriptor(item) });
      if (provider !== "middle") {
        const exports = hosts.get(provider) ?? [];
        if (!exports.some((entry) => entry.name === item.name)) exports.push({ name: item.name, ...descriptor(item) });
        hosts.set(provider, exports);
      }
    }
    if (id === "middle") requirements.set("lvcore", { provider: "lvcore", interface: "lvcore", version: 1, imports: [] });
    if (id === "app" && !requirements.has("middle")) requirements.set("middle", { provider: "middle", interface: "middle", version: 1, imports: [] });
    return { bytes, manifest: { schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
      interface: interfaces(id), memory_model: "isolated", requires: [...requirements.values()],
      exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(item) })), runtime_verification: "not-run" } };
  });
  if (!hosts.has("host.label")) hosts.set("host.label", []);
  const providers = [...hosts].map(([id, exports]) => ({ id, interface: interfaces(id === "host.label" ? "lvgl" : id.slice(5)), exports }));
  let factories = 0;
  const options: any = { profile: "lvgl-event-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: interfaces("lvw"), abiVersion: 1 },
    label: { id: "host.label", interface: interfaces("lvgl"), consumer: "middle", width: 8, height: 8, maxLabels: 4, maxTextBytes: 16 },
    event: { maxRegistrations: 2, maxDepth: 4 }, modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256,
      interface: manifest.interface, exports: [] })), hosts: providers.filter((item) => item.id === "host.trace").map((item) => ({ ...item,
      exports: item.exports.map(({ kind: _kind, ...fn }) => fn), create: () => { factories++; throw new Error("preflight created a host"); } })),
    allowedFeatures: [], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 2, maxTotalMemoryPages: 6, maxTableElements: 5, maxTotalTableElements: 10 };
  const input: any = { modules, hosts: providers };
  return { input, options, factories: () => factories };
}

async function middleWith(extra: string, memory = '(memory (export "memory") 1 2)') {
  let wat = await readFile("validator/lvgl-event-negative-app.wat", "utf8");
  const values: Record<string, string> = { EVENT_MODULE: "lvgl", EXTRA_IMPORT: extra,
    DISPATCH_EXPORT: '(func (export "app_event_dispatch") (param i32 i32) local.get 1 local.get 0 call_indirect (type $callback))',
    INDEX: "i32.const 1", CODE: "i32.const 123", INIT: "i32.const 0" };
  for (const [key, value] of Object.entries(values)) wat = wat.replaceAll(`@${key}@`, value);
  wat = wat.replace('(memory (export "memory") 1 2)', memory);
  if (/@[A-Z_]+@/.test(wat)) throw new Error("unexpanded event fixture");
  return compile(wat);
}

function check(fixture: Awaited<ReturnType<typeof fixture>>) {
  const prepared = prepareModuleManifests(fixture.input);
  const profile = prepareNumericProfile(prepared, fixture.options, true);
  compileNumericModules(prepared);
  return { prepared, profile };
}

async function legacyFixture() {
  const f = await fixture("app", await Bun.file(`${directory}/app.wasm`).bytes(), await compile(mainWat));
  delete f.options.label.consumer;
  f.input.modules.find((item: any) => item.manifest.id === "app").manifest.requires
    .push({ provider: "lvcore", interface: "lvcore", version: 1, imports: [] });
  return f;
}

test("an event consumer may be an independent library in a three-module graph", async () => {
  const f = await fixture();
  const { prepared, profile } = check(f);
  expect(profile.labelConsumer).toBe("middle");
  expect(prepared.order).toEqual(["lvcore", "middle", "app"]);
  expect(f.factories()).toBe(0);
});

test("an owned externref table cannot hold the consumer's callbacks", async () => {
  const f = await fixture("app", undefined, await compile(emptyConsumerWat.replace("funcref", "externref")));
  expect(() => prepareModuleManifests(f.input)).not.toThrow();
  expect(() => check(f)).toThrow("LVGL event consumer requires a function table");
  expect(f.factories()).toBe(0);
});

test("a preflight-only profile cannot instantiate a library event consumer", async () => {
  const f = await fixture();
  const prepared = prepareModuleManifests(f.input);
  const profile = prepareNumericProfile(prepared, f.options, true);
  const compiled = compileNumericModules(prepared);
  let beforeGuest = 0;
  expect(() => instantiateNumericEnvironment(prepared, profile, compiled, () => { beforeGuest++; }))
    .toThrow("LVGL event consumer must be its app");
  expect(f.factories()).toBe(0);
  expect(beforeGuest).toBe(0);
});

test("the existing app event consumer remains the default", async () => {
  const f = await legacyFixture();
  expect(check(f).profile.labelConsumer).toBe("app");
  expect(f.factories()).toBe(0);
});

for (const variant of ["app-reactor-trap", "app-init-trap", "app-dispatch-trap"] as const) {
  test(`${variant} is compiled but its guest entrypoint is not executed`, async () => {
    const f = await fixture(variant);
    expect(() => check(f)).not.toThrow();
    expect(f.factories()).toBe(0);
  });
}

for (const [variant, message] of [
  ["app-no-dispatch", "missing app_event_dispatch"],
  ["app-bad-dispatch", "invalid app_event_dispatch signature"],
  ["app-imported-dispatch", "app_event_dispatch must be an owned function"],
  ["app-no-table", "requires its own table"],
  ["app-imported-table", "requires its own table"],
  ["app-unbounded-table", "numeric table limit exceeded"],
  ["app-multiple-tables", "requires its own table"],
] as const) {
  test(`${variant} is rejected on the selected library before host creation`, async () => {
    const f = await fixture(variant);
    expect(() => prepareModuleManifests(f.input)).not.toThrow();
    expect(() => check(f)).toThrow(message);
    expect(f.factories()).toBe(0);
  });
}

test("consumer identity, edges, and other modules are checked against actual bytes", async () => {
  for (const [kind, message] of [["core", "invalid LVGL label consumer"], ["missing", "invalid LVGL label consumer"],
    ["sha", "numeric module is not authorized"], ["core-edge", "label consumer must depend on its LVGL core"],
    ["provider-edge", "label consumer must depend on its label provider"], ["host-spoof", "LVGL label host is reserved for its consumer"]] as const) {
    const f = await fixture("app", kind === "host-spoof" ? await Bun.file(`${directory}/app.wasm`).bytes() : undefined);
    const middle = f.input.modules.find((entry: any) => entry.manifest.id === "middle");
    if (kind === "core" || kind === "missing") f.options.label.consumer = kind === "core" ? "lvcore" : "missing";
    if (kind === "sha") f.options.modules.find((item: any) => item.id === "middle").sha256 = "0".repeat(64);
    if (kind === "core-edge") middle.manifest.requires = middle.manifest.requires.filter((item: any) => item.provider !== "lvcore");
    if (kind === "provider-edge") {
      const bytes = await compile(emptyConsumerWat), facts = inspectWasmFacts(bytes);
      middle.bytes = bytes; middle.manifest.artifact.sha256 = facts.sha256;
      middle.manifest.exports = facts.exports.map((item) => ({ name: item.name, kind: item.kind,
        ...(item.kind === "function" || item.kind === "tag" ? facts.types[item.typeIndex] : item.type) }));
      middle.manifest.requires = middle.manifest.requires.filter((item: any) => item.provider === "lvcore");
      f.options.modules.find((item: any) => item.id === "middle").sha256 = facts.sha256;
    }
    expect(() => prepareModuleManifests(f.input), kind).not.toThrow();
    expect(() => check(f), kind).toThrow(message);
    expect(f.factories(), kind).toBe(0);
  }
});

test("the consumer cannot re-export its managed event import by another name", async () => {
  const bytes = await middleWith('(export "renamed_add" (func $add))');
  const f = await fixture("app", undefined, bytes);
  const facts = inspectWasmFacts(bytes);
  const imported = facts.imports.find((item) => item.module === "lvgl" && item.name === "lv_obj_add_event_cb");
  const exported = facts.exports.find((item) => item.name === "renamed_add");
  expect(imported?.kind).toBe("function");
  expect(exported?.kind).toBe("function");
  expect(exported?.index).toBe(imported?.index);
  expect(() => prepareModuleManifests(f.input)).not.toThrow();
  expect(() => check(f)).toThrow('"middle": LVGL label imports cannot be re-exported');
  expect(f.factories()).toBe(0);
});

test("the consumer must export its own memory", async () => {
  const f = await fixture("app", undefined, await middleWith("", "(memory 1 2)"));
  expect(() => prepareModuleManifests(f.input)).not.toThrow();
  expect(() => check(f)).toThrow("label profile requires owned exported memory");
  expect(f.factories()).toBe(0);
});

test("another module cannot import the consumer dispatcher", async () => {
  const app = await compile(mainWat.replace('(memory (export "memory") 1 2)',
    '(import "middle" "app_event_dispatch" (func (param i32 i32))) (memory (export "memory") 1 2)'));
  const f = await fixture("app", app);
  expect(() => prepareModuleManifests(f.input)).not.toThrow();
  expect(() => check(f)).toThrow('"app": unsupported numeric import');
  expect(f.factories()).toBe(0);
});

test("dispatcher aliases cannot be authorized as business exports", async () => {
  const f = await fixture("app-dispatch-alias");
  const middle = f.input.modules.find((entry: any) => entry.manifest.id === "middle");
  const facts = inspectWasmFacts(middle.bytes);
  const dispatcher = facts.exports.find((item) => item.name === "app_event_dispatch");
  const alias = facts.exports.find((item) => item.name === "dispatch_alias");
  expect(dispatcher?.kind).toBe("function");
  expect(alias?.kind).toBe("function");
  expect(alias?.index).toBe(dispatcher?.index);
  expect(() => check(f)).not.toThrow();
  f.options.modules.find((item: any) => item.id === "middle").exports.push({ name: "dispatch_alias", params: ["i32", "i32"], results: ["i32"] });
  expect(() => check(f)).toThrow("LVGL event dispatcher cannot be a business export");
  expect(f.factories()).toBe(0);
});

test("another module cannot import a dispatcher alias", async () => {
  const app = await compile(mainWat.replace('(memory (export "memory") 1 2)',
    '(import "middle" "dispatch_alias" (func (param i32 i32))) (memory (export "memory") 1 2)'));
  const f = await fixture("app-dispatch-alias", app);
  const middle = f.input.modules.find((entry: any) => entry.manifest.id === "middle");
  const facts = inspectWasmFacts(middle.bytes);
  const dispatcher = facts.exports.find((item) => item.name === "app_event_dispatch");
  const alias = facts.exports.find((item) => item.name === "dispatch_alias");
  expect(alias?.index).toBe(dispatcher?.index);
  expect(() => prepareModuleManifests(f.input)).not.toThrow();
  expect(() => check(f)).toThrow('"app": unsupported numeric import');
  expect(f.factories()).toBe(0);
});

test("the consumer's undeclared Wasm feature is rejected by feature inspection", async () => {
  const bytes = await middleWith('(func v128.const i32x4 0 0 0 0 drop)');
  const f = await fixture("app", undefined, bytes);
  expect(() => check(f)).not.toThrow();
  f.options.allowedFeatures.push("simd");
  const error = await featureValidator.inspectFeatureModuleGraph(f.input, f.options).then(() => null, (failure) => failure);
  expect(String(error)).toContain('"middle": feature inspection failed');
  expect(String(error)).toContain("invalid under the declared feature policy");
  expect(f.factories()).toBe(0);
}, 300_000);

test("public event preflight snapshots a trusted consumer and does not authorize execution", async () => {
  const f = await fixture();
  const expected = f.input.modules.map((module: any) => ({ id: module.manifest.id, sha256: inspectWasmFacts(module.bytes).sha256 }));
  const operation = featureValidator.preflightLvglEventGraphForConsumer(f.input, f.options);
  f.options.label.consumer = "app";
  f.options.modules.find((item: any) => item.id === "middle").sha256 = "0".repeat(64);
  f.options.allowedFeatures.push("simd");
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
  expect(f.factories()).toBe(0);
}, 300_000);

test("event preflight does not broaden the label preflight or runtime loader", async () => {
  const f = await fixture();
  await expect(featureValidator.loadNumericEnvironment(f.input, f.options))
    .rejects.toThrow("LVGL event consumer must be its app");
  expect(f.factories()).toBe(0);
  const legacy = await legacyFixture();
  expect(() => check(legacy)).not.toThrow();
  await expect(featureValidator.preflightLvglLabelGraphForConsumer(legacy.input, legacy.options))
    .rejects.toThrow("label consumer preflight requires lvgl-label-v1");
  const report = await featureValidator.preflightLvglEventGraphForConsumer(legacy.input, legacy.options);
  expect(report.consumer).toBe("app");
  expect(report.graph.order).toEqual(["lvcore", "middle", "app"]);
  expect(legacy.factories()).toBe(0);
}, 300_000);
