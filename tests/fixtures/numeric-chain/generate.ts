import { link, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { inspectWasmFacts, type WasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  fixtures: { type: "string" }, core: { type: "string" }, api: { type: "string" }, proof: { type: "string" }, output: { type: "string" },
  "real-only": { type: "boolean", default: false },
} });
if (!values.fixtures || !values.output) throw new Error("--fixtures and --output are required");
const root = resolve(import.meta.dir, "../../..");
const corePath = values.core ?? join(root, "target/wasm/liblvgl-bounded.wasm");
const apiPath = values.api ?? join(root, "target/wasm/api.json");
const proofPath = values.proof ?? join(root, "target/wasm/api-verification-bounded.json");
const output = resolve(values.output);
const fixtures = await realpath(values.fixtures);
const parent = await realpath(dirname(output));
const target = await realpath(join(root, "target"));
const physicalOutput = join(parent, basename(output));
const inside = (directory: string, path: string) => {
  const part = relative(directory, path);
  return !part || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
if (!inside(target, physicalOutput) || physicalOutput === target) throw new Error("chain graph output must be inside target");
if (inside(fixtures, physicalOutput) || inside(physicalOutput, fixtures)) throw new Error("chain graph output overlaps fixtures");
for (const input of [corePath, apiPath, proofPath]) {
  if (physicalOutput === await realpath(input)) throw new Error("chain graph output overlaps an input");
}
try { await lstat(physicalOutput); throw new Error("chain graph output already exists"); }
catch (error: any) { if (error.code !== "ENOENT") throw error; }

const names = ["middle.wasm", "middle-fail-init.wasm", "app.wasm", "app-fail-init.wasm"] as const;
async function snapshot(path: string, limit: number) {
  const file = Bun.file(path);
  if (file.size > limit) throw new Error("chain input exceeds limit");
  const bytes = await file.bytes();
  if (bytes.length > limit) throw new Error("chain input exceeds limit");
  return bytes;
}
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const markerBytes = await snapshot(join(fixtures, "manifest.json"), 65536);
const marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(markerBytes));
if (!marker || Array.isArray(marker) || Object.keys(marker).sort().join() !== "files,kind,schema_version"
    || marker.schema_version !== 1 || marker.kind !== "lvgl-chain-fixtures" || !marker.files
    || Array.isArray(marker.files) || Object.keys(marker.files).sort().join() !== [...names].sort().join()) {
  throw new Error("invalid chain fixture manifest");
}
const inputs = new Map<string, Uint8Array>();
for (const name of names) {
  if (typeof marker.files[name] !== "string" || !/^[0-9a-f]{64}$/.test(marker.files[name])) throw new Error("invalid chain fixture identity");
  const bytes = await snapshot(join(fixtures, name), 64 * 1024 * 1024);
  if (hash(bytes) !== marker.files[name]) throw new Error(`chain fixture identity mismatch: ${name}`);
  inputs.set(name, bytes);
}
const coreBytes = await snapshot(corePath, 64 * 1024 * 1024);
const apiBytes = await snapshot(apiPath, 32 * 1024 * 1024);
const proofBytes = await snapshot(proofPath, 1024 * 1024);
const work = await mkdtemp(join(parent, ".numeric-chain-"));
try {
  const core = join(work, "core.wasm"), api = join(work, "api.json"), proof = join(work, "proof.json");
  const middle = join(work, "middle.wasm"), basePath = join(work, "base.json");
  await Bun.write(core, coreBytes); await Bun.write(api, apiBytes); await Bun.write(proof, proofBytes);
  await Bun.write(middle, inputs.get("middle.wasm")!);
  const base = Bun.spawnSync([process.execPath, join(root, "tests/fixtures/numeric-lvgl/generate.ts"), "--real-only",
    "--core", core, "--app", middle, "--api", api, "--proof", proof, "--output", basePath], { cwd: root });
  if (base.exitCode !== 0) throw new Error(base.stderr.toString());
  const [checked] = JSON.parse(await readFile(basePath, "utf8"));
  const coreModule = checked.input.modules.find((entry: any) => entry.manifest.id === "lvcore");
  if (!coreModule || coreModule.manifest.artifact.sha256 !== hash(coreBytes)) throw new Error("chain core snapshot differs");
  const coreFacts = inspectWasmFacts(coreBytes);
  const descriptor = (facts: WasmFacts, item: any) => item.kind === "function" || item.kind === "tag"
    ? { kind: item.kind, ...facts.types[item.typeIndex]! } : { kind: item.kind, ...item.type };
  const iface = (name: string) => ({ name, version: 1 });
  const declared = (id: string, filename: string, allowed: Record<string, string[]>) => {
    const bytes = inputs.get(filename)!;
    const facts = inspectWasmFacts(bytes);
    const namespaces = Object.keys(allowed);
    if (facts.imports.length !== namespaces.reduce((sum, namespace) => sum + allowed[namespace]!.length, 0)
        || facts.imports.some((item) => item.kind !== "function" || !allowed[item.module]?.includes(item.name))
        || namespaces.some((namespace) => facts.imports.filter((item) => item.module === namespace).map((item) => item.name).sort().join()
          !== [...allowed[namespace]!].sort().join())) {
      throw new Error(`unexpected chain ${id} imports`);
    }
    const requires = namespaces.map((namespace) => ({ provider: namespace === "trace" ? "host.trace" : namespace,
      interface: namespace, version: 1, imports: facts.imports.filter((item) => item.module === namespace)
        .map((item) => ({ name: item.name, ...descriptor(facts, item), module: item.module, provider_export: item.name })) }));
    const manifest = { schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
      interface: iface(id), memory_model: "isolated", requires,
      exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(facts, item) })), runtime_verification: "not-run" };
    return { bytes, facts, manifest };
  };
  const trace = { name: "lifecycle", kind: "function", params: ["i32"], results: [] };
  const functions = ["middle_step", "middle_count", "middle_active"];
  const cases = [{ name: "real", middle: "middle.wasm", app: "app.wasm" }];
  if (!values["real-only"]) cases.push(
    { name: "middle-fail-init", middle: "middle-fail-init.wasm", app: "app.wasm" },
    { name: "app-fail-init", middle: "middle.wasm", app: "app-fail-init.wasm" },
  );
  const graphs = cases.map((item) => {
    const library = declared("middle", item.middle, { lvcore: ["lv_is_initialized"], trace: ["lifecycle"] });
    const app = declared("app", item.app, { middle: functions, trace: ["lifecycle"] });
    const middleExports = functions.map((name) => {
      const entry = library.manifest.exports.find((value) => value.name === name);
      if (!entry || entry.kind !== "function" || !Array.isArray(entry.params) || !Array.isArray(entry.results)) throw new Error(`missing middle function ${name}`);
      return { name, params: entry.params, results: entry.results };
    });
    const memories = [coreFacts, library.facts, app.facts].flatMap((facts) => facts.memories.map((memory) => memory.type.maximumPages));
    const tables = [coreFacts, library.facts, app.facts].flatMap((facts) => facts.tables.map((table) => table.type.maximum));
    if (memories.some((value) => value === null) || tables.some((value) => value === null)) throw new Error("unbounded chain resources");
    const memory = memories as number[], table = tables as number[];
    const hosts = checked.input.hosts.filter((host: any) => host.id !== "host.trace");
    hosts.push({ id: "host.trace", interface: iface("trace"), exports: [trace] });
    return { name: item.name, input: { modules: [
      { manifest: app.manifest, hex: Buffer.from(app.bytes).toString("hex") },
      { manifest: library.manifest, hex: Buffer.from(library.bytes).toString("hex") }, coreModule], hosts },
      profile: { modules: [{ id: "lvcore", sha256: coreFacts.sha256, interface: iface("lvcore"), exports: [{ name: "lv_is_initialized", params: [], results: ["i32"] }] },
        { id: "middle", sha256: library.facts.sha256, interface: iface("middle"), exports: middleExports },
        { id: "app", sha256: app.facts.sha256, interface: iface("app"), exports: [] }],
      hosts: [{ id: "host.trace", interface: iface("trace"), exports: [{ name: "lifecycle", params: ["i32"], results: [] }] }],
      limits: { maxMemoryPages: Math.max(...memory), maxTotalMemoryPages: memory.reduce((sum, value) => sum + value, 0),
        maxTableElements: Math.max(0, ...table), maxTotalTableElements: table.reduce((sum, value) => sum + value, 0) } },
      allowedFeatures: checked.allowedFeatures, wasi: true };
  });
  const graph = new TextEncoder().encode(JSON.stringify(graphs));
  if (graph.length > 256 * 1024 * 1024) throw new Error("chain graph exceeds size limit");
  const staged = join(work, "graph.json");
  await Bun.write(staged, graph);
  await link(staged, physicalOutput);
} finally {
  await rm(work, { recursive: true, force: true });
}
