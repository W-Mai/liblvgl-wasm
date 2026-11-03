import { parseArgs } from "node:util";
import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  fixtures: { type: "string" }, variants: { type: "string" }, output: { type: "string" },
} });
const directory = values.fixtures ?? "target/validator/wasi-numeric-fixtures";
const variants = values.variants ?? "target/validator/numeric-wasi-fixtures";
const output = values.output ?? "target/validator/numeric-wasi.json";
const cases = [
  { name: "dag", files: ["app", "lib"] },
  { name: "trace", files: ["app-trace", "lib-trace"] },
  { name: "bad-signature", files: ["app-bad-signature", "lib-bad-signature"] },
  { name: "alias", files: ["app-alias", "lib"] },
  { name: "c-app", files: ["c-app"] },
  { name: "init-fail", files: ["@app-init-fail", "lib"] },
  { name: "data-fail", files: ["@app-data-fail", "lib"] },
  { name: "import-memory", files: ["@app-import-memory", "lib"] },
  { name: "reexport-wasi", files: ["@app-reexport-wasi", "@lib-reexport-wasi"] },
];
const canonical = inspectWasmFacts(new Uint8Array(await Bun.file(`${directory}/lib.wasm`).arrayBuffer()));
const serviceExports = canonical.imports.filter((item) => item.module === "wasi_snapshot_preview1").map((item) => ({
  name: item.name, kind: "function", ...canonical.types[(item as any).typeIndex],
}));
const all: object[] = [];
for (const spec of cases) {
  const hosts: any[] = [{ id: "host.wasi", interface: { name: "wasi", version: 1 }, exports: structuredClone(serviceExports) }];
  const modules: any[] = [];
  for (let index = 0; index < spec.files.length; index++) {
    const file = spec.files[index]!;
    const id = index === 0 ? "app" : "lib";
    const path = file.startsWith("@") ? `${variants}/${file.slice(1)}.wasm` : `${directory}/${file}.wasm`;
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const facts = inspectWasmFacts(bytes);
    const descriptor = (item: any) => item.kind === "function" || item.kind === "tag"
      ? { kind: item.kind, ...facts.types[item.typeIndex] } : { kind: item.kind, ...item.type };
    const requirements = new Map<string, any>();
    for (const item of facts.imports) {
      const provider = item.module === "trace" ? "host.trace" : item.module === "lib" ? "lib" : "host.wasi";
      const interfaceName = provider === "host.wasi" ? "wasi" : provider === "host.trace" ? "trace" : provider;
      let requirement = requirements.get(provider);
      if (!requirement) { requirement = { provider, interface: interfaceName, version: 1, imports: [] }; requirements.set(provider, requirement); }
      requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...descriptor(item) });
    }
    const manifest = { schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
      interface: { name: id, version: 1 }, memory_model: "isolated", requires: [...requirements.values()],
      exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(item) })), runtime_verification: "not-run" };
    modules.push({ manifest, hex: Buffer.from(bytes).toString("hex") });
  }
  if (spec.name === "bad-signature") hosts[0].exports.find((item: any) => item.name === "fd_write").params.pop();
  if (["trace", "bad-signature"].includes(spec.name)) hosts.push({ id: "host.trace", interface: { name: "trace", version: 1 },
    exports: [{ name: "touch", kind: "function", params: ["i32"], results: [] }] });
  const profile = { modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256,
    interface: manifest.interface, exports: manifest.role === "app" ? [] : [{ name: "invoke", params: ["i32"], results: ["i32"] }] })),
    hosts: hosts.filter((item) => item.id !== "host.wasi").map((item) => ({ ...item, exports: item.exports.map(({ kind: _, ...fn }: any) => fn) })),
    limits: { maxMemoryPages: 4, maxTotalMemoryPages: 8, maxTableElements: 1, maxTotalTableElements: 1 } };
  if (spec.name === "reexport-wasi") profile.modules.find((item: any) => item.id === "lib").exports.push({ name: "close_alias", params: ["i32"], results: ["i32"] });
  all.push({ name: spec.name, input: { modules, hosts }, profile });
}
await Bun.write(output, JSON.stringify(all));
