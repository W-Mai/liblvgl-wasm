import { inspectWasmFacts, type WasmExternal } from "../../../bindings/typescript/src/wasm-facts.ts";
import { inspectFeatureModuleGraph, WASM_FEATURE_POLICY_NAMES } from "../../../target/validator/feature-validator.js";

const [input, output, featureList] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: bun real.ts INPUT.wasm OUTPUT.json [FEATURES|-]");
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
const allowedFeatures = featureList === undefined ? [...WASM_FEATURE_POLICY_NAMES] : featureList === "-" ? [] : featureList.split(",");
const manifest = {
  schema_version: 1 as const, kind: "wasm-module" as const, id: "app", role: "app" as const,
  artifact: { path: "app.wasm", sha256: facts.sha256 }, target: { abi: "wasip1" as const, features: allowedFeatures },
  interface: { name: "app", version: 1 }, memory_model: "isolated" as const,
  requires: [{ provider: "host.real", interface: "real", version: 1, imports }],
  exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(item) })), runtime_verification: "not-run" as const,
};
const hosts = [{ id: "host.real", interface: { name: "real", version: 1 }, exports: [...bindings.values()].map((item) => ({ name: item.name, ...item.type })) }];
const graph = { modules: [{ manifest, bytes }], hosts } as unknown as Parameters<typeof inspectFeatureModuleGraph>[0];
const report = await inspectFeatureModuleGraph(graph, { allowedFeatures, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000 });
if (report.order.length !== 1 || report.order[0] !== "app" || report.modules[0]?.sha256 !== facts.sha256) throw new Error("real graph mismatch");
await Bun.write(output, JSON.stringify({ input: { modules: [{ manifest, hex: Buffer.from(bytes).toString("hex") }], hosts },
  allowedFeatures, report: report.modules[0] }));
