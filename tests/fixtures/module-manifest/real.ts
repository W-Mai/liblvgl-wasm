import { inspectWasmFacts, type WasmExternal } from "../../../bindings/typescript/src/wasm-facts.ts";
import { prepareModuleManifests, type ModuleManifestInput } from "../../../bindings/typescript/src/module-manifest.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: bun real.ts INPUT.wasm OUTPUT.json");
const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
const facts = inspectWasmFacts(bytes);
function descriptor(item: WasmExternal): object {
  if (item.kind === "function" || item.kind === "tag") return { kind: item.kind, ...facts.types[item.typeIndex]! };
  return { kind: item.kind, ...item.type };
}
const bindings = new Map<string, { name: string; type: object }>();
const imports = facts.imports.map((item) => {
  const key = JSON.stringify([item.module, item.name]);
  const type = descriptor(item);
  let binding = bindings.get(key);
  if (binding && JSON.stringify(binding.type) !== JSON.stringify(type)) throw new Error("conflicting real import types");
  if (!binding) {
    binding = { name: `export.${bindings.size}`, type };
    bindings.set(key, binding);
  }
  return { module: item.module, name: item.name, provider_export: binding.name, ...type };
});
const manifest = {
  schema_version: 1, kind: "wasm-module", id: "app", role: "app",
  artifact: { path: "app.wasm", sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
  interface: { name: "app", version: 1 }, memory_model: "isolated",
  requires: [{ provider: "host.real", interface: "real", version: 1, imports }],
  exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(item) })), runtime_verification: "not-run",
};
const hosts = [{ id: "host.real", interface: { name: "real", version: 1 }, exports: [...bindings.values()].map((item) => ({ name: item.name, ...item.type })) }];
const checked = prepareModuleManifests({ modules: [{ manifest, bytes }], hosts } as unknown as ModuleManifestInput);
if (checked.order.length !== 1 || checked.order[0] !== "app" || checked.modules[0]?.facts.sha256 !== facts.sha256) throw new Error("real manifest mismatch");
await Bun.write(output, JSON.stringify({ modules: [{ manifest, hex: Buffer.from(bytes).toString("hex") }], hosts }));
