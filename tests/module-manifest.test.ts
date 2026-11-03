import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { validateModuleManifests } from "../bindings/typescript/src/index.ts";
import { prepareModuleManifests, type ModuleManifestInput } from "../bindings/typescript/src/module-manifest.ts";
import sharedCases from "./fixtures/module-manifest/cases.json";

for (const fixture of sharedCases) {
  test(`shared manifest: ${fixture.name}`, () => {
    const value = structuredClone(fixture.input);
    const modules = value.modules.map(({ manifest, hex }) => ({
      manifest,
      bytes: Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
    }));
    const input = { modules, hosts: value.hosts } as unknown as ModuleManifestInput;
    if (fixture.accepted) {
      const result = prepareModuleManifests(input);
      expect(result.order).toEqual(modules.length === 1 ? ["app"] : ["core", "widgets", "app"]);
      for (const record of result.modules) expect(record.facts.sha256).toBe(record.manifest.artifact.sha256);
    } else expect(() => prepareModuleManifests(input)).toThrow();
    if (fixture.engineValid !== undefined) {
      const binary = fixture.engineValid ? modules : modules.filter((item) => item.manifest.id === "core");
      for (const item of binary) expect(WebAssembly.validate(item.bytes)).toBe(fixture.engineValid);
    }
  });
}

const leb = (value: number): number[] => {
  const out: number[] = [];
  do { const part = value % 128; value = Math.floor(value / 128); out.push(part | (value ? 0x80 : 0)); } while (value);
  return out;
};
const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
const vec = (...entries: number[][]): number[] => [...leb(entries.length), ...entries.flat()];
const section = (id: number, payload: number[]): number[] => [id, ...leb(payload.length), ...payload];
const wasm = (...sections: number[][]): Uint8Array => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const imported = (module: string, name: string, kind: number, ...type: number[]): number[] => [...text(module), ...text(name), kind, ...type];
const exported = (name: string, kind: number, index: number): number[] => [...text(name), kind, ...leb(index)];
const body = (...instructions: number[]): number[] => { const bytes = [0, ...instructions, 0x0b]; return [...leb(bytes.length), ...bytes]; };
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// The start function traps if instantiated, so a successful check proves it did not execute.
function coreBytes(memoryMaximum: number | null = 4): Uint8Array {
  return wasm(
    section(1, vec([0x60, 1, 0x7f, 1, 0x7e], [0x60, 1, 0x7e, 0], [0x60, 0, 0])),
    section(2, vec(imported("env", "tick", 0, 2))),
    section(3, vec([0], [2])),
    section(4, vec([0x70, 1, 2, 5])),
    section(5, vec(memoryMaximum === null ? [0, 2] : [1, 2, memoryMaximum])),
    section(13, vec([0, 1])),
    section(6, vec([0x7f, 0, 0x41, 7, 0x0b])),
    section(7, vec(exported("convert", 0, 1), exported("table", 1, 0), exported("memory", 2, 0), exported("palette", 3, 0), exported("signal", 4, 0))),
    section(8, [2]),
    section(10, vec(body(0x20, 0, 0xac), body(0x00))),
  );
}

function widgetsBytes(extraTick = false): Uint8Array {
  return wasm(
    section(1, vec([0x60, 0, 0], [0x60, 1, 0x7f, 1, 0x7e])),
    section(2, vec(imported("core", "convert", 0, 1))),
    section(3, extraTick ? vec([1], [0]) : vec([1])),
    section(7, extraTick ? vec(exported("draw", 0, 1), exported("tick", 0, 2)) : vec(exported("draw", 0, 1))),
    section(10, extraTick ? vec(body(0x20, 0, 0x10, 0), body()) : vec(body(0x20, 0, 0x10, 0))),
  );
}

function appBytes(duplicate = false, options: {
  tableMinimum?: number; tableMaximum?: number; memoryMinimum?: number; memoryMaximum?: number;
  tableElement?: number; memoryShared?: boolean; globalMutable?: number; functionResult?: number; tagParameter?: number;
} = {}): Uint8Array {
  const imports = [
    imported("core", "convert", 0, 1),
    imported("core", "table", 1, options.tableElement ?? 0x70, 1, options.tableMinimum ?? 1, options.tableMaximum ?? 8),
    imported("core", "memory", 2, options.memoryShared ? 3 : 1, options.memoryMinimum ?? 1, options.memoryMaximum ?? 6),
    imported("core", "palette", 3, 0x7f, options.globalMutable ?? 0),
    imported("core", "signal", 4, 0, 2),
    imported("widgets", "render", 0, 1),
  ];
  if (duplicate) imports.push(imported("widgets", "render", 0, 1));
  return wasm(section(1, vec([0x60, 0, 0], [0x60, 1, 0x7f, 1, options.functionResult ?? 0x7e], [0x60, 1, options.tagParameter ?? 0x7e, 0])), section(2, vec(...imports)));
}

const functionType = { kind: "function", params: ["i32"], results: ["i64"] };
const tableType = { kind: "table", element: "funcref", minimum: 2, maximum: 5 };
const memoryType = { kind: "memory", minimumPages: 2, maximumPages: 4, shared: false };
const globalType = { kind: "global", value: "i32", mutable: false };
const tagType = { kind: "tag", params: ["i64"], results: [] };
const tickType = { kind: "function", params: [], results: [] };
const requireImport = (module: string, name: string, provider_export: string, type: object) => ({ module, name, provider_export, ...type });
const exportType = (name: string, type: object) => ({ name, ...type });

function fixture(duplicate = false): any {
  const core = coreBytes(), widgets = widgetsBytes(), app = appBytes(duplicate);
  const manifest = (id: string, role: "lib" | "app", bytes: Uint8Array, requires: object[], exports: object[]) => ({
    schema_version: 1, kind: "wasm-module", id, role,
    artifact: { path: `${id}.wasm`, sha256: hash(bytes) },
    target: { abi: "wasip1", features: [] }, interface: { name: id, version: 1 },
    memory_model: "isolated", requires, exports, runtime_verification: "not-run",
  });
  const widgetImport = requireImport("widgets", "render", "draw", functionType);
  return {
    modules: [
      { manifest: manifest("app", "app", app, [
        { provider: "core", interface: "core", version: 1, imports: [
          requireImport("core", "convert", "convert", functionType),
          requireImport("core", "table", "table", { ...tableType, minimum: 1, maximum: 8 }),
          requireImport("core", "memory", "memory", { ...memoryType, minimumPages: 1, maximumPages: 6 }),
          requireImport("core", "palette", "palette", globalType),
          requireImport("core", "signal", "signal", tagType),
        ] },
        { provider: "widgets", interface: "widgets", version: 1, imports: duplicate ? [widgetImport, { ...widgetImport }] : [widgetImport] },
      ], []), bytes: app },
      { manifest: manifest("widgets", "lib", widgets, [
        { provider: "core", interface: "core", version: 1, imports: [requireImport("core", "convert", "convert", functionType)] },
      ], [exportType("draw", functionType)]), bytes: widgets },
      { manifest: manifest("core", "lib", core, [
        { provider: "host.clock", interface: "clock", version: 1, imports: [requireImport("env", "tick", "now", tickType)] },
      ], [exportType("convert", functionType), exportType("table", tableType), exportType("memory", memoryType), exportType("palette", globalType), exportType("signal", tagType)]), bytes: core },
    ],
    hosts: [{ id: "host.clock", interface: { name: "clock", version: 1 }, exports: [exportType("now", tickType)] }],
  };
}

const validate = (value: any) => validateModuleManifests(value);
const byId = (value: any, id: string) => value.modules.find((item: any) => item.manifest.id === id);

function budgetFixture(id = "app", bytes = wasm()): any {
  return {
    manifest: { schema_version: 1, kind: "wasm-module", id, role: "app", artifact: { path: "app.wasm", sha256: hash(bytes) },
      target: { abi: "wasip1", features: [] }, interface: { name: "app", version: 1 }, memory_model: "isolated",
      requires: [], exports: [], runtime_verification: "not-run" },
    bytes,
  };
}

test("static manifest budgets count providers, entries and UTF-16 units", () => {
  const input: any = { modules: [budgetFixture()], hosts: Array.from({ length: 255 }, (_, i) => ({ id: `host.${i}`, interface: { name: "h", version: 1 }, exports: [] })) };
  expect(prepareModuleManifests(input).order).toEqual(["app"]);
  input.hosts.push({ id: "host.extra", interface: { name: "h", version: 1 }, exports: [] });
  expect(() => prepareModuleManifests(input)).toThrow("manifest inspection limit: providers");
  input.hosts = [{ id: "h", interface: { name: "h", version: 1 }, exports: [] }];
  input.modules[0].manifest.requires = Array.from({ length: 99_998 }, () => ({ provider: "h", interface: "h", version: 1, imports: [] }));
  expect(prepareModuleManifests(input).order).toEqual(["app"]);
  input.modules[0].manifest.requires.push({ provider: "h", interface: "h", version: 1, imports: [] });
  expect(() => prepareModuleManifests(input)).toThrow("manifest inspection limit: entries");
  input.hosts = [];
  input.modules[0].manifest.requires = [];
  input.modules[0].manifest.artifact.path = "😀".repeat(2_097_117);
  expect(prepareModuleManifests(input).order).toEqual(["app"]);
  input.modules[0].manifest.artifact.path += "a";
  expect(() => prepareModuleManifests(input)).toThrow("manifest inspection limit: string units");
}, 30_000);

test("static manifest facts budget is separate from declaration budget", () => {
  const types = (count: number) => wasm(section(1, [...leb(count), ...Array.from({ length: count }, () => [0x60, 0, 0]).flat()]));
  const bytes = types(50_000), first = budgetFixture("first", bytes), app = budgetFixture("app", bytes);
  first.manifest.role = "lib";
  const input = { modules: [first, app], hosts: [] };
  expect(prepareModuleManifests(input).order).toEqual(["first", "app"]);
  const second = budgetFixture("second", types(1));
  second.manifest.role = "lib";
  input.modules.push(second);
  expect(() => prepareModuleManifests(input)).toThrow("manifest inspection limit: total Wasm facts");
}, 30_000);

test("static manifest byte limits apply per module and across the graph", () => {
  const size = 64 * 1024 * 1024, bytes = new Uint8Array(size);
  bytes.set([0, 97, 115, 109, 1, 0, 0, 0]);
  let payload = size - 9;
  while (payload + leb(payload).length !== size - 9) payload--;
  bytes.set([0, ...leb(payload), 0], 8);
  const first = budgetFixture("first", bytes), app = budgetFixture("app", bytes);
  first.manifest.role = "lib";
  const input = { modules: [first, app], hosts: [] };
  expect(prepareModuleManifests(input).order).toEqual(["first", "app"]);
  const second = budgetFixture("second");
  second.manifest.role = "lib";
  input.modules.push(second);
  expect(() => prepareModuleManifests(input)).toThrow("Manifest inspection limit: total bytes");
  app.bytes = new Uint8Array(size + 1);
  expect(() => prepareModuleManifests({ modules: [app], hosts: [] })).toThrow("Wasm facts inspection limit: input bytes");
}, 30_000);

test("actual binaries bind an app, a library DAG and host without running a start function", () => {
  const input = fixture();
  for (const item of input.modules) expect(WebAssembly.validate(item.bytes)).toBe(true);
  const coreModule = new WebAssembly.Module(byId(input, "core").bytes);
  expect(() => new WebAssembly.Instance(coreModule, { env: { tick() {} } })).toThrow();
  const result = validate(input);
  expect(result.order).toEqual(["core", "widgets", "app"]);
  const core = result.modules.find((item: any) => item.id === "core")!;
  expect(core.facts.start).not.toBeNull();
  expect(core.checks).toEqual({
    declaration: "passed", identity: "passed", interface: "passed", engine: "passed",
    feature: "not-run", abi: "not-run", memoryIsolation: "not-run", hostImplementation: "not-run", runtime: "not-run",
  });
});

test("duplicate import occurrences are matched without collapsing bindings", () => {
  const input = fixture(true);
  expect(WebAssembly.validate(byId(input, "app").bytes)).toBe(true);
  expect(validate(input).order).toEqual(["core", "widgets", "app"]);
  byId(input, "app").manifest.requires[1].imports.pop();
  expect(() => validate(input)).toThrow(/import/i);
  const ambiguous = fixture(true);
  const app = byId(ambiguous, "app").manifest;
  app.requires[1].imports.pop();
  app.requires[0].imports.push(requireImport("widgets", "render", "convert", functionType));
  expect(() => validate(ambiguous)).toThrow(/ambiguous|conflict|provider/i);
});

test("import module and name are an exact pair, including special keys", () => {
  const pairs = [["a.b", "c"], ["a", "b.c"], ["a\0b", "c"], ["a", "b\0c"], ["__proto__", "constructor"]];
  const binary = wasm(section(1, vec([0x60, 0, 0])), section(2, vec(...pairs.map(([module, name]) => imported(module!, name!, 0, 0)))));
  const input = fixture();
  const app = byId(input, "app");
  input.modules = [app];
  app.bytes = binary;
  app.manifest.artifact.sha256 = hash(binary);
  app.manifest.requires = [{ provider: "host.clock", interface: "clock", version: 1,
    imports: pairs.map(([module, name]) => requireImport(module!, name!, "now", tickType)) }];
  expect(WebAssembly.validate(binary)).toBe(true);
  expect(validate(input).order).toEqual(["app"]);
  app.manifest.requires[0].imports[0].name = "b.c";
  expect(() => validate(input)).toThrow(/import/i);
});

test("identity and complete actual imports and exports cannot be forged", () => {
  let input = fixture();
  byId(input, "app").manifest.artifact.sha256 = "0".repeat(64);
  expect(() => validate(input)).toThrow(/sha-?256|hash|identity/i);
  input = fixture();
  byId(input, "app").manifest.requires[0].imports.splice(0, 1);
  expect(() => validate(input)).toThrow(/import/i);
  input = fixture();
  byId(input, "core").manifest.exports.pop();
  expect(() => validate(input)).toThrow(/export/i);
  input = fixture();
  byId(input, "core").manifest.exports.push(exportType("extra", functionType));
  expect(() => validate(input)).toThrow(/export/i);
  input = fixture();
  byId(input, "app").manifest.requires[0].imports.push(requireImport("core", "extra", "convert", functionType));
  expect(() => validate(input)).toThrow(/import/i);
  input = fixture();
  const app = byId(input, "app");
  app.bytes = app.bytes.slice();
  app.bytes[app.bytes.length - 1] ^= 1;
  expect(() => validate(input)).toThrow(/sha-?256|hash|identity/i);
  input = fixture();
  const malformed = byId(input, "core");
  malformed.bytes = malformed.bytes.slice();
  malformed.bytes[malformed.bytes.length - 1] = 0;
  malformed.manifest.artifact.sha256 = hash(malformed.bytes);
  expect(WebAssembly.validate(malformed.bytes)).toBe(false);
  expect(() => validate(input)).toThrow(/wasm|valid|compil/i);
});

test("captured engine rejects malformed code even when a manifest proxy replaces the global constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Module")!;
  const input = fixture();
  const core = byId(input, "core");
  core.bytes = core.bytes.slice();
  core.bytes[core.bytes.length - 1] = 0;
  core.manifest.artifact.sha256 = hash(core.bytes);
  let replaced = false, fakeCalls = 0;
  class FakeModule { constructor() { fakeCalls++; } }
  const app = byId(input, "app");
  app.manifest = new Proxy(app.manifest, {
    getPrototypeOf(target) {
      replaced = true;
      Object.defineProperty(WebAssembly, "Module", { ...descriptor, value: FakeModule });
      return Reflect.getPrototypeOf(target);
    },
  });
  try {
    expect(() => validate(input)).toThrow(/wasm|valid|compil/i);
    expect(replaced).toBe(true);
    expect(fakeCalls).toBe(0);
  } finally {
    Object.defineProperty(WebAssembly, "Module", descriptor);
  }
});

test("invalid declarations are rejected before an independent code validation failure", () => {
  const input = fixture();
  const core = byId(input, "core");
  core.bytes = core.bytes.slice();
  core.bytes[core.bytes.length - 1] = 0;
  core.manifest.artifact.sha256 = hash(core.bytes);
  const descriptor = byId(input, "app").manifest.requires[0].imports[0];
  descriptor.results = ["i32"];
  expect(() => validate(input)).toThrow(/import|declaration|signature|type/i);
  descriptor.results = ["i64"];
  expect(() => validate(input)).toThrow(/wasm|valid|compil/i);
});

test("reports retain the inspected snapshot and leave declared features unverified", () => {
  const input = fixture();
  const app = byId(input, "app");
  app.manifest.target.features = ["simd128"];
  const expectedHash = hash(app.bytes);
  const report = validate(input);
  const inspected = report.modules.find((item: any) => item.id === "app")!;
  app.bytes.fill(0);
  expect(inspected.facts.sha256).toBe(expectedHash);
  expect(inspected.checks.feature).toBe("not-run");
  expect(inspected.checks.abi).toBe("not-run");
  expect(inspected.checks.runtime).toBe("not-run");
});

test("function, tag, global and provider identities match their actual declarations", () => {
  for (const [entry, mutate] of [
    [0, (item: any) => { item.results = ["i32"]; }],
    [1, (item: any) => { item.element = "externref"; }],
    [2, (item: any) => { item.shared = true; }],
    [3, (item: any) => { item.mutable = true; }],
    [4, (item: any) => { item.params = ["i32"]; }],
  ] as const) {
    const input = fixture();
    mutate(byId(input, "app").manifest.requires[0].imports[entry]);
    expect(() => validate(input)).toThrow();
  }
  let input = fixture();
  byId(input, "app").manifest.requires[1].version = 2;
  expect(() => validate(input)).toThrow(/version|interface/i);
  input = fixture();
  byId(input, "app").manifest.requires[1].imports[0].provider_export = "missing";
  expect(() => validate(input)).toThrow(/export|missing/i);
  input = fixture();
  input.hosts[0].exports[0].results = ["i32"];
  expect(() => validate(input)).toThrow(/interface|type|signature|result/i);
});

test("provider limits follow the same direction as Wasm import matching", () => {
  const memoryImport = wasm(section(2, vec(imported("env", "memory", 2, 1, 1, 6))));
  const memoryModule = new WebAssembly.Module(memoryImport);
  expect(() => new WebAssembly.Instance(memoryModule, { env: { memory: new WebAssembly.Memory({ initial: 2, maximum: 4 }) } })).not.toThrow();
  expect(() => new WebAssembly.Instance(memoryModule, { env: { memory: new WebAssembly.Memory({ initial: 0, maximum: 4 }) } })).toThrow();
  expect(() => new WebAssembly.Instance(memoryModule, { env: { memory: new WebAssembly.Memory({ initial: 2, maximum: 7 }) } })).toThrow();
  const tableImport = wasm(section(2, vec(imported("env", "table", 1, 0x70, 1, 1, 8))));
  const tableModule = new WebAssembly.Module(tableImport);
  expect(() => new WebAssembly.Instance(tableModule, { env: { table: new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 5 }) } })).not.toThrow();
  expect(() => new WebAssembly.Instance(tableModule, { env: { table: new WebAssembly.Table({ element: "anyfunc", initial: 0, maximum: 5 }) } })).toThrow();
  expect(() => new WebAssembly.Instance(tableModule, { env: { table: new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 9 }) } })).toThrow();
  expect(validate(fixture()).order).toEqual(["core", "widgets", "app"]);
  for (const [index, key, value, options] of [
    [1, "minimum", 3, { tableMinimum: 3 }],
    [1, "maximum", 4, { tableMaximum: 4 }],
    [2, "minimumPages", 3, { memoryMinimum: 3 }],
    [2, "maximumPages", 3, { memoryMaximum: 3 }],
    [2, "shared", true, { memoryShared: true }],
  ] as const) {
    const input = fixture();
    const app = byId(input, "app");
    app.bytes = appBytes(false, options);
    app.manifest.artifact.sha256 = hash(app.bytes);
    app.manifest.requires[0].imports[index][key] = value;
    expect(WebAssembly.validate(app.bytes)).toBe(true);
    expect(() => validate(input)).toThrow(/type|limit|match|compatible/i);
  }
  const missingMaximum = fixture();
  const provider = byId(missingMaximum, "core");
  provider.bytes = coreBytes(null);
  provider.manifest.artifact.sha256 = hash(provider.bytes);
  provider.manifest.exports[2].maximumPages = null;
  expect(WebAssembly.validate(provider.bytes)).toBe(true);
  expect(() => validate(missingMaximum)).toThrow(/type|limit|match|compatible/i);
});

test("incompatible actual entity types are rejected even when each declaration matches its binary", () => {
  for (const [index, key, value, options] of [
    [0, "results", ["i32"], { functionResult: 0x7f }],
    [1, "element", "externref", { tableElement: 0x6f }],
    [3, "mutable", true, { globalMutable: 1 }],
    [4, "params", ["i32"], { tagParameter: 0x7f }],
  ] as const) {
    const input = fixture();
    const app = byId(input, "app");
    app.bytes = appBytes(false, options);
    app.manifest.artifact.sha256 = hash(app.bytes);
    app.manifest.requires[0].imports[index][key] = value;
    if (index === 0) app.manifest.requires[1].imports[0].results = ["i32"];
    expect(WebAssembly.validate(app.bytes)).toBe(true);
    expect(() => validate(input)).toThrow(/type|match|compatible|signature/i);
  }
});

test("nested type and name budgets apply cumulatively to every declared occurrence", () => {
  function largeInput(count: number): any {
    const width = 500;
    const params = new Array(width).fill("i32");
    const binary = wasm(
      section(1, vec([0x60, ...leb(width), ...new Array(width).fill(0x7f), 0])),
      section(2, vec(...new Array(count).fill(imported("env", "f", 0, 0)))),
    );
    const descriptor = { kind: "function", params, results: [] };
    const manifest = {
      schema_version: 1, kind: "wasm-module", id: "app", role: "app",
      artifact: { path: "app.wasm", sha256: hash(binary) },
      target: { abi: "wasip1", features: [] }, interface: { name: "app", version: 1 },
      memory_model: "isolated", requires: [{ provider: "host.fn", interface: "fn", version: 1,
        imports: new Array(count).fill(null).map(() => requireImport("env", "f", "f", descriptor)) }],
      exports: [], runtime_verification: "not-run",
    };
    return { modules: [{ manifest, bytes: binary }], hosts: [{ id: "host.fn", interface: { name: "fn", version: 1 }, exports: [exportType("f", descriptor)] }] };
  }
  const small = largeInput(3);
  expect(WebAssembly.validate(small.modules[0].bytes)).toBe(true);
  expect(validate(small).order).toEqual(["app"]);
  const large = largeInput(210);
  expect(WebAssembly.validate(large.modules[0].bytes)).toBe(true);
  expect(() => validate(large)).toThrow(/limit|budget/i);
  const longNames = fixture();
  const longName = "x".repeat(2 * 1024 * 1024 + 1);
  longNames.hosts[0].interface.name = longName;
  byId(longNames, "core").manifest.requires[0].interface = longName;
  expect(() => validate(longNames)).toThrow(/limit|budget/i);
});

test("unsafe paths, unsupported declarations, graph conflicts and tampered buffers are rejected", () => {
  for (const path of ["", "/core.wasm", "../core.wasm", "a/../core.wasm", "a//core.wasm", "a\\core.wasm", "a%2fcore.wasm", "a?x", "a#x"]) {
    const input = fixture(); byId(input, "core").manifest.artifact.path = path;
    expect(() => validate(input)).toThrow(/path/i);
  }
  let input = fixture();
  byId(input, "app").manifest.unexpected = true;
  expect(() => validate(input)).toThrow(/unknown|extra|unexpected|field|property/i);
  input = fixture();
  byId(input, "app").manifest.interface.version = -1;
  expect(() => validate(input)).toThrow(/version/i);
  input = fixture();
  byId(input, "app").manifest.interface.version = 1.5;
  expect(() => validate(input)).toThrow(/version/i);
  input = fixture();
  byId(input, "core").manifest.target.abi = "unknown";
  expect(() => validate(input)).toThrow(/abi|target/i);
  input = fixture();
  byId(input, "core").manifest.memory_model = "shared";
  expect(() => validate(input)).toThrow(/memory|model/i);
  input = fixture();
  input.hosts.push({ ...input.hosts[0], id: "core" });
  expect(() => validate(input)).toThrow(/duplicate|provider/i);
  input = fixture();
  const widgets = byId(input, "widgets");
  widgets.bytes = widgetsBytes(true);
  widgets.manifest.artifact.sha256 = hash(widgets.bytes);
  widgets.manifest.exports.push(exportType("tick", tickType));
  byId(input, "core").manifest.requires = [{ provider: "widgets", interface: "widgets", version: 1,
    imports: [requireImport("env", "tick", "tick", tickType)] }];
  expect(() => validate(input)).toThrow(/cycle/i);
  input = fixture();
  byId(input, "widgets").manifest.requires[0].provider = "app";
  expect(() => validate(input)).toThrow(/app|provider/i);
  input = fixture();
  let accessed = false;
  Object.defineProperty(byId(input, "app").manifest.artifact, "sha256", { get() { accessed = true; return "0".repeat(64); } });
  expect(() => validate(input)).toThrow();
  expect(accessed).toBe(false);
});
