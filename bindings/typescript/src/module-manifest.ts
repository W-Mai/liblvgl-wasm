import { orderModuleGraph } from "./module-graph.ts";
import { inspectWasmSnapshot, snapshotWasmBytes, type WasmExternal, type WasmFacts, type WasmValueType } from "./wasm-facts.ts";

const WasmModule = WebAssembly.Module;

export type ModuleExternalType =
  | { readonly kind: "function" | "tag"; readonly params: readonly WasmValueType[]; readonly results: readonly WasmValueType[] }
  | { readonly kind: "table"; readonly element: "funcref" | "externref"; readonly minimum: number; readonly maximum: number | null }
  | { readonly kind: "memory"; readonly minimumPages: number; readonly maximumPages: number | null; readonly shared: boolean }
  | { readonly kind: "global"; readonly value: WasmValueType; readonly mutable: boolean };

export type ModuleExport = { readonly name: string } & ModuleExternalType;
export type ModuleImport = { readonly module: string; readonly name: string; readonly provider_export: string } & ModuleExternalType;
export interface ModuleInterface { readonly name: string; readonly version: number }
export interface ModuleManifest {
  readonly schema_version: 1;
  readonly kind: "wasm-module";
  readonly id: string;
  readonly role: "lib" | "app";
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly target: { readonly abi: "wasip1"; readonly features: readonly string[] };
  readonly interface: ModuleInterface;
  readonly memory_model: "isolated";
  readonly requires: readonly { readonly provider: string; readonly interface: string; readonly version: number; readonly imports: readonly ModuleImport[] }[];
  readonly exports: readonly ModuleExport[];
  readonly runtime_verification: "not-run";
}
export interface ModuleHostProvider { readonly id: string; readonly interface: ModuleInterface; readonly exports: readonly ModuleExport[] }
export interface ModuleManifestInput { readonly modules: readonly { readonly manifest: ModuleManifest; readonly bytes: BufferSource }[]; readonly hosts: readonly ModuleHostProvider[] }
export interface ModuleManifestReport {
  readonly order: readonly string[];
  readonly modules: readonly { readonly id: string; readonly facts: WasmFacts; readonly checks: {
    readonly declaration: "passed"; readonly identity: "passed"; readonly interface: "passed"; readonly engine: "passed";
    readonly feature: "not-run"; readonly abi: "not-run"; readonly memoryIsolation: "not-run";
    readonly hostImplementation: "not-run"; readonly runtime: "not-run";
  } }[];
}

export const MODULE_MANIFEST_LIMITS = Object.freeze({ providers: 256, bytes: 128 * 1024 * 1024, entries: 100_000, stringUnits: 4 * 1024 * 1024 });
interface Budget { entries: number; stringUnits: number }
type Fields = Record<string, unknown>;
type Requirement = ModuleManifest["requires"][number];
type Binding = { readonly requirement: Requirement; readonly item: ModuleImport };

function fail(message: string): never { throw new Error(message); }
function object(value: unknown, keys: readonly string[], label: string, knownKind?: PropertyDescriptor): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${label}: expected a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(`${label}: expected a plain object`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return fail(`${label}: unknown or missing fields`);
  const result: Fields = Object.create(null);
  for (const key of keys) {
    const property = key === "kind" && knownKind ? knownKind : Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) return fail(`${label}: invalid field ${JSON.stringify(key)}`);
    result[key] = property.value;
  }
  return result;
}
function list(value: unknown, budget: Budget, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail(`${label}: expected an array`);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MODULE_MANIFEST_LIMITS.entries - budget.entries) return fail(`${label}: manifest inspection limit: entries`);
  budget.entries += length;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) return fail(`${label}: invalid array fields`);
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !("value" in property) || !property.enumerable) return fail(`${label}: invalid array entry ${i}`);
    result.push(property.value);
  }
  return result;
}
function string(value: unknown, budget: Budget, label: string, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && (!value || value.trim() !== value))) return fail(`${label}: invalid string`);
  if (value.length > MODULE_MANIFEST_LIMITS.stringUnits - budget.stringUnits) return fail(`${label}: manifest inspection limit: string units`);
  budget.stringUnits += value.length;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail(`${label}: invalid Unicode`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return fail(`${label}: invalid Unicode`);
  }
  return value;
}
function integer(value: unknown, label: string, max = 0xffff_ffff, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return fail(`${label}: invalid integer`);
  return value as number;
}
function maximum(value: unknown, min: number, label: string, max: number): number | null {
  return value === null ? null : integer(value, label, max, min);
}
function interfaceType(value: unknown, budget: Budget, label: string): ModuleInterface {
  const item = object(value, ["name", "version"], label);
  return { name: string(item.name, budget, `${label}.name`), version: integer(item.version, `${label}.version`, 0xffff_ffff, 1) };
}
function literal<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) return fail(`${label}: expected ${JSON.stringify(expected)}`);
  return expected;
}
const valueTypes = new Set<WasmValueType>(["i32", "i64", "f32", "f64", "v128", "funcref", "externref"]);
function valueType(value: unknown, label: string): WasmValueType {
  if (typeof value !== "string" || !valueTypes.has(value as WasmValueType)) return fail(`${label}: unsupported Wasm value type`);
  return value as WasmValueType;
}
function external(value: unknown, extras: readonly string[], budget: Budget, label: string): Fields & ModuleExternalType {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${label}: expected a plain object`);
  const kindProperty = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kindProperty || !("value" in kindProperty)) return fail(`${label}: invalid kind`);
  const kind = kindProperty.value;
  if (kind === "function" || kind === "tag") {
    const item = object(value, [...extras, "kind", "params", "results"], label, kindProperty);
    const params = list(item.params, budget, `${label}.params`).map((x) => valueType(x, `${label}.params`));
    const results = list(item.results, budget, `${label}.results`).map((x) => valueType(x, `${label}.results`));
    if (kind === "tag" && results.length) return fail(`${label}: tag results must be empty`);
    return { ...item, kind, params, results };
  }
  if (kind === "table") {
    const item = object(value, [...extras, "kind", "element", "minimum", "maximum"], label, kindProperty);
    if (item.element !== "funcref" && item.element !== "externref") return fail(`${label}: unsupported table element`);
    const minimum = integer(item.minimum, `${label}.minimum`);
    return { ...item, kind, element: item.element, minimum, maximum: maximum(item.maximum, minimum, `${label}.maximum`, 0xffff_ffff) };
  }
  if (kind === "memory") {
    const item = object(value, [...extras, "kind", "minimumPages", "maximumPages", "shared"], label, kindProperty);
    const minimumPages = integer(item.minimumPages, `${label}.minimumPages`, 65536);
    const maximumPages = maximum(item.maximumPages, minimumPages, `${label}.maximumPages`, 65536);
    if (typeof item.shared !== "boolean" || (item.shared && maximumPages === null)) return fail(`${label}: invalid shared memory limits`);
    return { ...item, kind, minimumPages, maximumPages, shared: item.shared };
  }
  if (kind === "global") {
    const item = object(value, [...extras, "kind", "value", "mutable"], label, kindProperty);
    if (typeof item.mutable !== "boolean") return fail(`${label}: invalid global mutability`);
    return { ...item, kind, value: valueType(item.value, `${label}.value`), mutable: item.mutable };
  }
  return fail(`${label}: unsupported external kind`);
}
function exportItem(value: unknown, budget: Budget, label: string): ModuleExport {
  const item = external(value, ["name"], budget, label);
  return { ...item, name: string(item.name, budget, `${label}.name`, false) } as ModuleExport;
}
function importItem(value: unknown, budget: Budget, label: string): ModuleImport {
  const item = external(value, ["module", "name", "provider_export"], budget, label);
  return { ...item, module: string(item.module, budget, `${label}.module`, false), name: string(item.name, budget, `${label}.name`, false),
    provider_export: string(item.provider_export, budget, `${label}.provider_export`, false) } as ModuleImport;
}
function exportsList(value: unknown, budget: Budget, label: string): ModuleExport[] {
  const names = new Set<string>();
  return list(value, budget, label).map((entry) => {
    const item = exportItem(entry, budget, label);
    if (names.has(item.name)) return fail(`${label}: duplicate export ${JSON.stringify(item.name)}`);
    names.add(item.name);
    return item;
  });
}
function manifest(value: unknown, budget: Budget, label: string): ModuleManifest {
  const item = object(value, ["schema_version", "kind", "id", "role", "artifact", "target", "interface", "memory_model", "requires", "exports", "runtime_verification"], label);
  literal(item.schema_version, 1, `${label}.schema_version`);
  literal(item.kind, "wasm-module", `${label}.kind`);
  const id = string(item.id, budget, `${label}.id`);
  if (item.role !== "lib" && item.role !== "app") return fail(`${label}.role: expected lib or app`);
  const artifact = object(item.artifact, ["path", "sha256"], `${label}.artifact`);
  const path = string(artifact.path, budget, `${label}.artifact.path`);
  if (/[\\:%?#\u0000-\u001f\u007f]/u.test(path) || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) return fail(`${label}.artifact.path: expected a safe relative path`);
  const hash = string(artifact.sha256, budget, `${label}.artifact.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(hash)) return fail(`${label}.artifact.sha256: expected lowercase SHA-256`);
  const target = object(item.target, ["abi", "features"], `${label}.target`);
  literal(target.abi, "wasip1", `${label}.target.abi`);
  const features = list(target.features, budget, `${label}.target.features`).map((x) => string(x, budget, `${label}.target.features`));
  if (new Set(features).size !== features.length) return fail(`${label}.target.features: duplicate feature`);
  literal(item.memory_model, "isolated", `${label}.memory_model`);
  literal(item.runtime_verification, "not-run", `${label}.runtime_verification`);
  const requires = list(item.requires, budget, `${label}.requires`).map((value) => {
    const req = object(value, ["provider", "interface", "version", "imports"], `${label}.requires`);
    return { provider: string(req.provider, budget, `${label}.requires.provider`), interface: string(req.interface, budget, `${label}.requires.interface`),
      version: integer(req.version, `${label}.requires.version`, 0xffff_ffff, 1),
      imports: list(req.imports, budget, `${label}.requires.imports`).map((x) => importItem(x, budget, `${label}.requires.imports`)) };
  });
  return { schema_version: 1, kind: "wasm-module", id, role: item.role, artifact: { path, sha256: hash },
    target: { abi: "wasip1", features }, interface: interfaceType(item.interface, budget, `${label}.interface`),
    memory_model: "isolated", requires, exports: exportsList(item.exports, budget, `${label}.exports`), runtime_verification: "not-run" };
}
function host(value: unknown, budget: Budget, label: string): ModuleHostProvider {
  const item = object(value, ["id", "interface", "exports"], label);
  return { id: string(item.id, budget, `${label}.id`), interface: interfaceType(item.interface, budget, `${label}.interface`), exports: exportsList(item.exports, budget, `${label}.exports`) };
}

function externalFact(facts: WasmFacts, item: WasmExternal): ModuleExternalType {
  if (item.kind === "function" || item.kind === "tag") {
    const type = facts.types[item.typeIndex]!;
    return { kind: item.kind, params: type.params, results: type.results };
  }
  if (item.kind === "table") return { kind: "table", ...item.type };
  if (item.kind === "memory") return { kind: "memory", ...item.type };
  return { kind: "global", ...item.type };
}
function key(item: ModuleExternalType): string {
  switch (item.kind) {
    case "function": case "tag": return JSON.stringify([item.kind, item.params, item.results]);
    case "table": return JSON.stringify([item.kind, item.element, item.minimum, item.maximum]);
    case "memory": return JSON.stringify([item.kind, item.minimumPages, item.maximumPages, item.shared]);
    case "global": return JSON.stringify([item.kind, item.value, item.mutable]);
  }
}
function compatible(required: ModuleExternalType, provided: ModuleExternalType): boolean {
  if (required.kind !== provided.kind) return false;
  if (required.kind === "table" && provided.kind === "table") return required.element === provided.element && provided.minimum >= required.minimum && (required.maximum === null || (provided.maximum !== null && provided.maximum <= required.maximum));
  if (required.kind === "memory" && provided.kind === "memory") return required.shared === provided.shared && provided.minimumPages >= required.minimumPages && (required.maximumPages === null || (provided.maximumPages !== null && provided.maximumPages <= required.maximumPages));
  return key(required) === key(provided);
}
function factKey(facts: WasmFacts, item: WasmExternal, cache: Map<WasmFacts, Map<number, string>>): string {
  if (item.kind !== "function" && item.kind !== "tag") return key(externalFact(facts, item));
  let signatures = cache.get(facts);
  if (!signatures) { signatures = new Map(); cache.set(facts, signatures); }
  let signature = signatures.get(item.typeIndex);
  if (signature === undefined) {
    const type = facts.types[item.typeIndex]!;
    signature = JSON.stringify([type.params, type.results]);
    signatures.set(item.typeIndex, signature);
  }
  return item.kind + signature;
}
function descriptorKey(item: ModuleExternalType): string {
  return item.kind === "function" || item.kind === "tag" ? item.kind + JSON.stringify([item.params, item.results]) : key(item);
}
function pairMap<T>(map: Map<string, Map<string, T>>, first: string, second: string, create: () => T): T {
  let inner = map.get(first);
  if (!inner) { inner = new Map(); map.set(first, inner); }
  let value = inner.get(second);
  if (value === undefined) { value = create(); inner.set(second, value); }
  return value;
}
function location(id: string, module: string, name: string): string { return `${JSON.stringify(id)} import ${JSON.stringify(module)}.${JSON.stringify(name)}`; }

/** @internal A graph and the snapshots owned by its current inspection. */
export interface PreparedModuleGraph {
  readonly order: readonly string[];
  readonly hosts: readonly ModuleHostProvider[];
  readonly modules: readonly { readonly manifest: ModuleManifest; readonly bytes: Uint8Array<ArrayBuffer>; readonly facts: WasmFacts }[];
}

/** @internal Inspect the graph and retain its private input snapshots. */
export function prepareModuleManifests(input: ModuleManifestInput): PreparedModuleGraph {
  const budget: Budget = { entries: 0, stringUnits: 0 };
  const root = object(input, ["modules", "hosts"], "environment");
  const moduleInputs = list(root.modules, budget, "environment.modules");
  if (moduleInputs.length > MODULE_MANIFEST_LIMITS.providers) return fail("manifest inspection limit: providers");
  const source = moduleInputs.map((value, index) => object(value, ["manifest", "bytes"], `module[${index}]`));
  let totalBytes = 0;
  const snapshots = source.map((item) => {
    const bytes = snapshotWasmBytes(item.bytes as BufferSource, MODULE_MANIFEST_LIMITS.bytes - totalBytes);
    totalBytes += bytes.byteLength;
    return bytes;
  });
  const hostInputs = list(root.hosts, budget, "environment.hosts");
  if (moduleInputs.length + hostInputs.length > MODULE_MANIFEST_LIMITS.providers) return fail("manifest inspection limit: providers");
  const records = source.map((item, index) => ({ manifest: manifest(item.manifest, budget, `module[${index}].manifest`), bytes: snapshots[index]! }));
  const hosts = hostInputs.map((value, index) => host(value, budget, `host[${index}]`));
  const order = orderModuleGraph({ modules: records.map((record) => record.manifest), hostProviders: hosts.map((entry) => entry.id) });
  const factsById = new Map<string, WasmFacts>();
  let totalFacts = 0;
  for (const record of records) {
    const facts = inspectWasmSnapshot(record.bytes);
    totalFacts += facts.types.length + facts.imports.length + facts.exports.length + facts.functions.length + facts.tables.length + facts.memories.length + facts.globals.length + facts.tags.length;
    for (const type of facts.types) totalFacts += type.params.length + type.results.length;
    if (totalFacts > MODULE_MANIFEST_LIMITS.entries) return fail("manifest inspection limit: total Wasm facts");
    if (facts.sha256 !== record.manifest.artifact.sha256) return fail(`${JSON.stringify(record.manifest.id)}: artifact SHA-256 mismatch: expected ${record.manifest.artifact.sha256}, actual ${facts.sha256}`);
    factsById.set(record.manifest.id, facts);
  }
  const recordsById = new Map(records.map((record) => [record.manifest.id, record.manifest]));
  const hostsById = new Map(hosts.map((entry) => [entry.id, entry]));
  const exportFactsById = new Map([...factsById].map(([id, facts]) => [id, new Map(facts.exports.map((item) => [item.name, item]))]));
  const hostExportsById = new Map(hosts.map((entry) => [entry.id, new Map(entry.exports.map((item) => [item.name, item]))]));
  const signatureCache = new Map<WasmFacts, Map<number, string>>();
  const hostKeys = new Map<ModuleExport, string>();
  for (const record of records) {
    const current = record.manifest, facts = factsById.get(current.id)!;
    for (const requirement of current.requires) {
      const selected = recordsById.get(requirement.provider) ?? hostsById.get(requirement.provider);
      if (!selected) return fail(`${JSON.stringify(current.id)} -> ${JSON.stringify(requirement.provider)}: missing provider`);
      if (selected.interface.name !== requirement.interface || selected.interface.version !== requirement.version) return fail(`${JSON.stringify(current.id)} -> ${JSON.stringify(requirement.provider)}: interface mismatch; expected ${JSON.stringify([requirement.interface, requirement.version])}, actual ${JSON.stringify([selected.interface.name, selected.interface.version])}`);
    }
    const actualExports = exportFactsById.get(current.id)!;
    const declaredExports = new Set(current.exports.map((item) => item.name));
    for (const item of current.exports) {
      const actual = actualExports.get(item.name);
      if (!actual || descriptorKey(item) !== factKey(facts, actual, signatureCache)) return fail(`${JSON.stringify(current.id)} export ${JSON.stringify(item.name)}: declaration does not match artifact; expected ${descriptorKey(item)}, actual ${actual ? factKey(facts, actual, signatureCache) : "missing"}`);
    }
    for (const name of actualExports.keys()) if (!declaredExports.has(name)) return fail(`${JSON.stringify(current.id)} export ${JSON.stringify(name)}: artifact export has no declaration`);
    const bindings = new Map<string, Map<string, { provider: string; providerExport: string }>>();
    const declared = new Map<string, Map<string, Map<string, Binding[]>>>();
    for (const requirement of current.requires) for (const item of requirement.imports) {
      const binding = pairMap(bindings, item.module, item.name, () => ({ provider: requirement.provider, providerExport: item.provider_export }));
      if (binding.provider !== requirement.provider || binding.providerExport !== item.provider_export) return fail(`${location(current.id, item.module, item.name)}: conflicting provider bindings`);
      const types = pairMap(declared, item.module, item.name, () => new Map());
      const signature = descriptorKey(item);
      const entries = types.get(signature) ?? [];
      entries.push({ requirement, item });
      types.set(signature, entries);
    }
    const matched: Binding[] = [];
    for (const item of facts.imports) {
      const actual = factKey(facts, item, signatureCache), types = declared.get(item.module)?.get(item.name), matches = types?.get(actual);
      const binding = matches?.pop();
      if (!binding) {
        const expected = types?.keys().next().value;
        return fail(`${location(current.id, item.module, item.name)}: artifact import has no matching declaration; expected ${expected ?? "missing"}, actual ${actual}`);
      }
      matched.push(binding);
    }
    for (const [module, names] of declared) for (const [name, signatures] of names) for (const remaining of signatures.values()) {
      if (remaining.length) return fail(`${location(current.id, module, name)} -> ${JSON.stringify(remaining[0]!.requirement.provider)}: import declaration has no matching artifact import`);
    }
    for (const { requirement, item } of matched) {
      const provider = recordsById.get(requirement.provider), hostProvider = hostsById.get(requirement.provider);
      const selected = provider ?? hostProvider;
      if (!selected) return fail(`${location(current.id, item.module, item.name)}: missing provider ${JSON.stringify(requirement.provider)}`);
      if (selected.interface.name !== requirement.interface || selected.interface.version !== requirement.version) return fail(`${location(current.id, item.module, item.name)} -> ${JSON.stringify(requirement.provider)}: interface mismatch; expected ${JSON.stringify([requirement.interface, requirement.version])}, actual ${JSON.stringify([selected.interface.name, selected.interface.version])}`);
      const providerFacts = provider && factsById.get(provider.id)!;
      const providerExport = provider && exportFactsById.get(provider.id)!.get(item.provider_export);
      const hostExport = hostProvider && hostExportsById.get(hostProvider.id)!.get(item.provider_export);
      const provided = providerExport && providerFacts ? externalFact(providerFacts, providerExport) : hostExport;
      let actualKey = "missing";
      if (providerExport && providerFacts) actualKey = factKey(providerFacts, providerExport, signatureCache);
      else if (hostExport) {
        actualKey = hostKeys.get(hostExport) ?? descriptorKey(hostExport);
        hostKeys.set(hostExport, actualKey);
      }
      const matches = provided && ((item.kind === "function" || item.kind === "tag") ? descriptorKey(item) === actualKey : compatible(item, provided));
      if (!matches) return fail(`${location(current.id, item.module, item.name)} -> ${JSON.stringify(requirement.provider)} export ${JSON.stringify(item.provider_export)}: type mismatch; expected ${descriptorKey(item)}, actual ${actualKey}`);
    }
  }
  return { order, hosts, modules: records.map((record) => ({ ...record, facts: factsById.get(record.manifest.id)! })) };
}

/** @internal Compile the same snapshots without instantiating them. */
export function compilePreparedModules(prepared: PreparedModuleGraph): void {
  for (const record of prepared.modules) {
    try { new WasmModule(record.bytes); } catch (error) { fail(`${JSON.stringify(record.manifest.id)}: current engine compilation failed: ${String(error)}`); }
  }
}

/** Inspect static module declarations and compile their private byte snapshots without instantiating them. */
export function validateModuleManifests(input: ModuleManifestInput): ModuleManifestReport {
  const prepared = prepareModuleManifests(input);
  compilePreparedModules(prepared);
  return { order: prepared.order, modules: prepared.modules.map(({ manifest: current, facts }) => ({ id: current.id, facts, checks: {
    declaration: "passed", identity: "passed", interface: "passed", engine: "passed", feature: "not-run", abi: "not-run",
    memoryIsolation: "not-run", hostImplementation: "not-run", runtime: "not-run",
  } })) };
}
