import { parseArgs } from "node:util";
import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  core: { type: "string" }, app: { type: "string" }, "fail-app": { type: "string" }, api: { type: "string" },
  proof: { type: "string" }, lifecycle: { type: "string" }, extra: { type: "string" }, output: { type: "string" },
  "real-only": { type: "boolean", default: false },
} });
const corePath = values.core ?? "target/wasm/liblvgl-bounded.wasm";
const appPath = values.app ?? "target/validator/lvgl-core-app.wasm";
const failPath = values["fail-app"] ?? "target/validator/lvgl-core-app-fail-init.wasm";
const apiPath = values.api ?? "target/wasm/api.json";
const proofPath = values.proof ?? "target/wasm/api-verification-bounded.json";
const lifecycle = values.lifecycle ?? "target/validator/lvgl-lifecycle";
const extra = values.extra ?? "target/validator/numeric-lvgl";
const output = values.output ?? "target/validator/numeric-lvgl.json";
async function readWasm(path: string) {
  const file = Bun.file(path);
  if (file.size > 64 * 1024 * 1024) throw new Error("fixture Wasm exceeds limit");
  const bytes = await file.bytes();
  if (bytes.length > 64 * 1024 * 1024) throw new Error("fixture Wasm exceeds limit");
  return bytes;
}
const coreFile = Bun.file(corePath), apiFile = Bun.file(apiPath), proofFile = Bun.file(proofPath);
if (coreFile.size > 64 * 1024 * 1024 || apiFile.size > 32 * 1024 * 1024 || proofFile.size > 1024 * 1024) throw new Error("core proof inputs exceed limits");
const coreBytes = await coreFile.bytes(), apiBytes = await apiFile.bytes(), proofBytes = await proofFile.bytes();
if (coreBytes.length > 64 * 1024 * 1024 || apiBytes.length > 32 * 1024 * 1024 || proofBytes.length > 1024 * 1024) throw new Error("core proof inputs exceed limits");
const api = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(apiBytes));
const proof = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proofBytes));
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const declared = new Set<string>();
for (const declaration of api.declarations) {
  if (declaration.category === "unsupported" || declaration.category === "compile_disabled") continue;
  if (!["direct_export", "abi_shim"].includes(declaration.category) || typeof declaration.export_name !== "string"
      || !declaration.export_name || declared.has(declaration.export_name)) throw new Error("invalid core API inventory");
  declared.add(declaration.export_name);
}
const keys = ["schema_version", "api_sha256", "wasm_sha256", "expected_functions", "verified_functions"];
if (api.schema_version !== 1 || proof === null || typeof proof !== "object" || Array.isArray(proof)
    || Object.keys(proof).length !== keys.length || Object.keys(proof).some((key) => !keys.includes(key))
    || proof.schema_version !== 1 || proof.api_sha256 !== hash(apiBytes) || proof.wasm_sha256 !== hash(coreBytes)
    || !Number.isSafeInteger(proof.expected_functions) || proof.expected_functions <= 0
    || proof.expected_functions !== proof.verified_functions || proof.expected_functions !== api.wasm_summary.expected_functions
    || proof.expected_functions !== declared.size) throw new Error("bounded core proof does not match its inputs");

const callbacks = ["event", "timer", "timer_release", "anim_exec", "anim_query", "anim_notify", "anim_release",
  "observer", "observer_release", "decoder_info", "decoder_open", "decoder_area", "decoder_close", "decoder_release"];
const cases: { name: string; real: boolean; files: [string, string][] }[] = [
  { name: "real", real: true, files: [["app", appPath], ["lvcore", corePath]] },
];
if (!values["real-only"]) {
  cases.push({ name: "real-fail", real: true, files: [["app", failPath], ["lvcore", corePath]] });
  const variants = ["core", "core-bad-abi", "core-init-fail", "core-init-trap", "core-reactor-trap",
    "core-close-trap", "core-close-fail", "core-run-trap", "core-event-init", "core-event-run", "core-bad-event",
    "core-alias-event", "core-missing-init", "core-imported-init", "core-bad-abi-signature"];
  for (const variant of variants) cases.push({ name: variant, real: false, files: [["app", `${lifecycle}/app.wasm`], ["lvcore", `${lifecycle}/${variant}.wasm`], ["base", `${lifecycle}/base.wasm`]] });
  for (const app of ["app-fail", "app-reserved", "app-steal"]) cases.push({ name: app, real: false, files: [["app", `${lifecycle}/${app}.wasm`], ["lvcore", `${lifecycle}/core.wasm`], ["base", `${lifecycle}/base.wasm`]] });
  for (const name of callbacks) cases.push({ name: `callback-${name}`, real: false, files: [["app", `${lifecycle}/app.wasm`], ["lvcore", `${extra}/callback-${name}.wasm`], ["base", `${lifecycle}/base.wasm`]] });
  cases.push({ name: "rollback-trap", real: false, files: [["app", `${lifecycle}/app.wasm`], ["lvcore", `${lifecycle}/core-bad-abi.wasm`], ["base", `${lifecycle}/base-close-trap.wasm`]] });
}
const features = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
const all: object[] = [];
for (const spec of cases) {
  const modules: any[] = [], hostExports = new Map<string, any[]>();
  let maxMemoryPages = 0, maxTotalMemoryPages = 0, maxTableElements = 0, maxTotalTableElements = 0;
  for (const [id, path] of spec.files) {
    const bytes = path === corePath ? coreBytes : await readWasm(path);
    const facts = inspectWasmFacts(bytes);
    const descriptor = (item: any) => item.kind === "function" || item.kind === "tag"
      ? { kind: item.kind, ...facts.types[item.typeIndex] } : { kind: item.kind, ...item.type };
    const requirements = new Map<string, any>();
    for (const item of facts.imports) {
      const provider = item.module === "trace" ? "host.trace" : item.module === "wasi_snapshot_preview1" ? "host.wasi"
        : item.module === "lvw" || item.module === "not-lvw" ? "host.lvw" : item.module === "core" ? "lvcore" : item.module;
      const interfaceName = provider.startsWith("host.") ? provider.slice(5) : provider;
      let requirement = requirements.get(provider);
      if (!requirement) { requirement = { provider, interface: interfaceName, version: 1, imports: [] }; requirements.set(provider, requirement); }
      const type = descriptor(item);
      requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...type });
      if (provider.startsWith("host.")) {
        const entries = hostExports.get(provider) ?? [];
        if (!entries.some((entry) => entry.name === item.name)) entries.push({ name: item.name, ...type });
        hostExports.set(provider, entries);
      }
    }
    for (const memory of facts.memories) {
      if (memory.type.maximumPages === null) throw new Error("unbounded fixture memory");
      maxMemoryPages = Math.max(maxMemoryPages, memory.type.maximumPages); maxTotalMemoryPages += memory.type.maximumPages;
    }
    for (const table of facts.tables) {
      if (table.type.maximum === null) throw new Error("unbounded fixture table");
      maxTableElements = Math.max(maxTableElements, table.type.maximum); maxTotalTableElements += table.type.maximum;
    }
    const manifest = { schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: spec.real && id === "lvcore" ? features : [] },
      interface: { name: id, version: 1 }, memory_model: "isolated", requires: [...requirements.values()],
      exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(item) })), runtime_verification: "not-run" };
    modules.push({ manifest, hex: Buffer.from(bytes).toString("hex") });
  }
  const hosts = [...hostExports].map(([id, exports]) => ({ id, interface: { name: id.slice(5), version: 1 }, exports }));
  const profile = { modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256,
    interface: manifest.interface, exports: manifest.id === "base" ? [{ name: "ping", params: [], results: ["i32"] }]
      : manifest.id === "lvcore" ? [{ name: spec.real ? "lv_is_initialized" : "lv_tick_get", params: [], results: ["i32"] }] : [] })),
    hosts: hosts.filter((item) => item.id === "host.trace").map((item) => ({ ...item, exports: item.exports.map(({ kind: _, ...fn }: any) => fn) })),
    limits: { maxMemoryPages, maxTotalMemoryPages, maxTableElements, maxTotalTableElements } };
  all.push({ name: spec.name, input: { modules, hosts }, profile, allowedFeatures: spec.real ? features : [], wasi: spec.real });
}
await Bun.write(output, JSON.stringify(all));
