import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(2), options: { fixtures: { type: "string" }, output: { type: "string" } } });
const directory = values.fixtures ?? "target/validator/numeric-fixtures";
const output = values.output ?? "target/validator/numeric-preflight.json";
const names = ["app", "a", "b", "core"];
const tableVariants: Record<string, string> = {
  "core-table": "(table 1 2 funcref)", "b-table": "(table 1 2 funcref)",
  "core-unbounded-table": "(table 1 funcref)",
};
for (const [name, table] of Object.entries(tableVariants)) {
  const source = await Bun.file(`validator/numeric-${name.split("-")[0]}.wat`).text();
  const process = Bun.spawnSync(["wasm-tools", "parse", "-o", `${directory}/${name}.wasm`, "-"], {
    stdin: Buffer.from(source.replace("(memory 1 2)", `(memory 1 2)\n  ${table}`)),
  });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  const validation = Bun.spawnSync(["wasm-tools", "validate", "--features=wasm1", `${directory}/${name}.wasm`]);
  if (validation.exitCode !== 0) throw new Error(validation.stderr.toString());
}
const entryVariants: Record<string, [string, string, string]> = {
  "core-missing-close": ["core", '(export "module_close")', '(export "hidden_close")'],
  "b-wrong-init": ["b", '(export "module_init")', '(export "hidden_init")'],
  "app-wrong-run": ["app", '(export "app_run")', '(export "hidden_run")'],
};
for (const [name, [module, before, after]] of Object.entries(entryVariants)) {
  let source = (await Bun.file(`validator/numeric-${module}.wat`).text()).replace(before, after);
  const extra = name === "b-wrong-init" ? '(func (export "module_init"))' : name === "app-wrong-run" ? '(func (export "app_run") (result i32) i32.const 0)' : "";
  source = source.replace(/\)\s*$/, `  ${extra}\n)`);
  const process = Bun.spawnSync(["wasm-tools", "parse", "-o", `${directory}/${name}.wasm`, "-"], { stdin: Buffer.from(source) });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  const validation = Bun.spawnSync(["wasm-tools", "validate", "--features=wasm1", `${directory}/${name}.wasm`]);
  if (validation.exitCode !== 0) throw new Error(validation.stderr.toString());
}
let memoryless = await Bun.file("validator/numeric-core.wat").text();
memoryless = memoryless.replace("  (memory 1 2)\n", "")
  .replace("i32.const 0 i32.load", "i32.const 0")
  .replace("    i32.const 0 local.get 0 i32.const 10 i32.add i32.store\n", "");
const memorylessBuild = Bun.spawnSync(["wasm-tools", "parse", "-o", `${directory}/core-memoryless.wasm`, "-"], { stdin: Buffer.from(memoryless) });
if (memorylessBuild.exitCode !== 0) throw new Error(memorylessBuild.stderr.toString());
const memorylessValidation = Bun.spawnSync(["wasm-tools", "validate", "--features=wasm1", `${directory}/core-memoryless.wasm`]);
if (memorylessValidation.exitCode !== 0) throw new Error(memorylessValidation.stderr.toString());

const descriptions = [
  { name: "dag", pass: true },
  { name: "reactor-trap-not-run", pass: true, app: "app-reactor-trap" },
  { name: "init-trap-not-run", pass: true, app: "app-init-trap" },
  { name: "close-trap-not-run", pass: true, app: "app-close-trap" },
  { name: "memoryless-core", pass: true, core: "core-memoryless", maxTotalMemoryPages: 6 },
  { name: "memory-zero", error: "memory limit", maxMemoryPages: 0 },
  { name: "memory-total-zero", error: "resource limit", maxTotalMemoryPages: 0 },
  { name: "memory-total", error: "resource limit", maxTotalMemoryPages: 7 },
  { name: "memory-single", error: "memory limit", maxMemoryPages: 1 },
  { name: "table-zero", error: "table limit", core: "core-table" },
  { name: "table-total-zero", error: "resource limit", core: "core-table", maxTableElements: 2, maxTotalTableElements: 0 },
  { name: "table-single", error: "table limit", core: "core-table", maxTableElements: 1, maxTotalTableElements: 4 },
  { name: "table-total", error: "resource limit", core: "core-table", b: "b-table", maxTableElements: 2, maxTotalTableElements: 3 },
  { name: "table-boundary", pass: true, core: "core-table", b: "b-table", maxTableElements: 2, maxTotalTableElements: 4 },
  { name: "table-unbounded", error: "table limit", core: "core-unbounded-table", maxTableElements: 2, maxTotalTableElements: 2 },
  { name: "memory-unbounded", error: "memory limit", app: "app-unbounded" },
  { name: "wasi", error: "WASI imports", app: "app-wasi" },
  { name: "command", error: "_start", app: "app-start" },
  { name: "memory-import", error: "unsupported numeric import", core: "core-export-memory", app: "app-memory-import" },
  { name: "table-import", error: "unsupported numeric import", core: "core-export-table", app: "app-table-import", maxTableElements: 2, maxTotalTableElements: 4 },
  { name: "float-import", error: "numeric import is not authorized", core: "core-f32", app: "app-f32" },
  { name: "v128-import", error: "numeric import is not authorized", core: "core-v128", app: "app-v128", features: ["simd"] },
  { name: "imported-init", error: "must be an owned function", app: "app-import-init" },
  { name: "missing-close", error: "module_close", core: "core-missing-close" },
  { name: "wrong-init", error: "module_init", b: "b-wrong-init" },
  { name: "wrong-app-run", error: "app_run", app: "app-wrong-run" },
  { name: "reserved-import", error: "unsupported numeric import", b: "b-reserved" },
  { name: "identity", error: "not authorized", mutation: "identity" },
  { name: "interface", error: "not authorized", mutation: "interface" },
  { name: "unauthorized-export", error: "numeric import is not authorized", mutation: "unauthorized" },
  { name: "wrong-export-signature", error: "numeric export contract differs", mutation: "signature" },
  { name: "host-interface", error: "numeric host contract differs", mutation: "host-interface" },
  { name: "host-signature", error: "numeric host export differs", mutation: "host-signature" },
  { name: "host-result", error: "numeric host export differs", mutation: "host-result" },
  { name: "missing-host", error: "provider inventory differs", mutation: "missing-host" },
] as const;

const fn = (name: string, params: string[], results: string[]) => ({ name, params, results });
const business = [fn("calc", ["i32"], ["i32"]), fn("read", [], ["i32"])];
const host = { id: "host.trace", interface: { name: "host.trace", version: 1 }, exports: [fn("event", ["i32"], [])] };
const cases: object[] = [];
for (const raw of descriptions) {
  const spec: any = raw;
  const modules = [];
  for (const id of names) {
    const binary = new Uint8Array(await Bun.file(`${directory}/${spec[id] ?? id}.wasm`).arrayBuffer());
    const facts = inspectWasmFacts(binary);
    const descriptor = (item: any) => item.kind === "function" || item.kind === "tag"
      ? { kind: item.kind, ...facts.types[item.typeIndex] } : { kind: item.kind, ...item.type };
    const requirements = new Map<string, any>();
    for (const item of facts.imports) {
      const provider = item.module === "trace" ? "host.trace" : item.module === "wasi_snapshot_preview1" ? "host.wasi" : item.module;
      let requirement = requirements.get(provider);
      if (!requirement) { requirement = { provider, interface: provider, version: 1, imports: [] }; requirements.set(provider, requirement); }
      requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...descriptor(item) });
    }
    const manifest = { schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: spec.features ?? [] },
      interface: { name: id, version: 1 }, memory_model: "isolated", requires: [...requirements.values()],
      exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(item) })), runtime_verification: "not-run" };
    modules.push({ manifest, hex: Buffer.from(binary).toString("hex") });
  }
  const hosts: any[] = [{ ...host, exports: host.exports.map((value) => ({ ...value, kind: "function" })) }];
  const profileHosts: any[] = [structuredClone(host)];
  if (spec.name === "wasi") {
    const fd = fn("fd_write", ["i32", "i32", "i32", "i32"], ["i32"]);
    hosts.push({ id: "host.wasi", interface: { name: "host.wasi", version: 1 }, exports: [{ ...fd, kind: "function" }] });
    profileHosts.push({ id: "host.wasi", interface: { name: "host.wasi", version: 1 }, exports: [fd] });
  }
  const contracts = modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256,
    interface: structuredClone(manifest.interface), exports: manifest.role === "app" ? [] : structuredClone(business) }));
  const core = contracts.find((item) => item.id === "core")!;
  if (spec.mutation === "identity") core.sha256 = "0".repeat(64);
  if (spec.mutation === "interface") core.interface.version = 2;
  if (spec.mutation === "unauthorized") core.exports = [core.exports[1]!];
  if (spec.mutation === "signature") core.exports[0]!.params = [];
  if (spec.mutation === "host-interface") profileHosts[0].interface.version = 2;
  if (spec.mutation === "host-signature") profileHosts[0].exports[0].params = [];
  if (spec.mutation === "host-result") profileHosts[0].exports[0].results = ["i32"];
  if (spec.mutation === "missing-host") profileHosts.length = 0;
  cases.push({ name: spec.name, pass: !!spec.pass, error: spec.error ?? "", input: { modules, hosts },
    profile: { modules: contracts, hosts: profileHosts, limits: { maxMemoryPages: spec.maxMemoryPages ?? 2,
      maxTotalMemoryPages: spec.maxTotalMemoryPages ?? 8, maxTableElements: spec.maxTableElements ?? 0,
      maxTotalTableElements: spec.maxTotalTableElements ?? 0 } }, allowedFeatures: spec.features ?? [] });
}
await Bun.write(output, JSON.stringify(cases));
