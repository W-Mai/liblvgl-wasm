import { EventAdapter, eventDispatch, eventImports } from "./numeric-events.ts";
import type { ModuleExport, ModuleInterface, PreparedModuleGraph } from "./module-manifest.ts";
import { createNumericWasiBudget, createNumericWasiConsumer, NUMERIC_WASI_SIGNATURES, prepareNumericWasi, NumericWasiExit,
  type NumericWasiOptions, type NumericWasiService } from "./numeric-wasi.ts";

export { NumericWasiExit };
export type { NumericWasiOptions, NumericWasiService };

const WasmModule = WebAssembly.Module;
const WasmInstance = WebAssembly.Instance;
const reserved = new Set(["_initialize", "_start", "module_init", "module_close", "app_run"]);
const lvglLifecycle = new Set(["lvw_abi_version", "lvw_init", "lvw_shutdown"]);
const lvglScalars = new Set(["lv_is_initialized", "lv_tick_get"]);
const lvglCallbacks: Readonly<Record<string, string>> = Object.freeze({
  event: "iii/", timer: "ii/", timer_release: "i/", anim_exec: "iii/", anim_query: "iii/i",
  anim_notify: "iii/", anim_release: "i/", observer: "iii/", observer_release: "i/",
  decoder_info: "iiii/i", decoder_open: "iii/i", decoder_area: "iiiii/i", decoder_close: "iii/", decoder_release: "i/",
});
const labelImports: Readonly<Record<string, string>> = Object.freeze({ lv_screen_active: "/i", lv_label_create: "i/i", lv_label_set_text: "ii/" });
let nextLabelToken = 1;

export interface NumericFunctionContract {
  readonly name: string;
  readonly params: readonly "i32"[];
  readonly results: readonly "i32"[];
}

export interface NumericModuleContract {
  readonly id: string;
  readonly sha256: string;
  readonly interface: ModuleInterface;
  readonly exports: readonly NumericFunctionContract[];
}

export interface NumericHostInstance {
  readonly exports: Readonly<Record<string, (...args: number[]) => number | void>>;
  readonly close: () => void;
}

export interface NumericHostContract {
  readonly id: string;
  readonly interface: ModuleInterface;
  readonly exports: readonly NumericFunctionContract[];
  readonly create: (consumerId: string, environmentId: symbol) => NumericHostInstance;
}

export interface NumericEnvironmentOptions {
  readonly profile: "numeric-v1" | "lvgl-core-v1" | "lvgl-label-v1" | "lvgl-event-v1";
  readonly lvgl?: { readonly module: string; readonly id: string; readonly interface: ModuleInterface; readonly abiVersion: 1 };
  readonly label?: { readonly id: string; readonly interface: ModuleInterface; readonly width: number; readonly height: number;
    readonly maxLabels: number; readonly maxTextBytes: number; readonly consumer?: string };
  readonly event?: { readonly maxRegistrations: number; readonly maxDepth: number };
  readonly modules: readonly NumericModuleContract[];
  readonly hosts: readonly NumericHostContract[];
  readonly wasi?: NumericWasiOptions;
  readonly allowedFeatures: readonly string[];
  readonly startupTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxMemoryPages: number;
  readonly maxTotalMemoryPages: number;
  readonly maxTableElements: number;
  readonly maxTotalTableElements: number;
}

type NumericRecord = PreparedModuleGraph["modules"][number];
interface NumericProfile {
  readonly modules: ReadonlyMap<string, NumericModuleContract>;
  readonly hosts: ReadonlyMap<string, NumericHostContract>;
  readonly wasi?: NumericWasiOptions;
  readonly lvgl?: NonNullable<NumericEnvironmentOptions["lvgl"]>;
  readonly label?: NonNullable<NumericEnvironmentOptions["label"]>;
  readonly event?: NonNullable<NumericEnvironmentOptions["event"]>;
  readonly app: string;
  readonly labelConsumer?: string;
  readonly featureOptions: Pick<NumericEnvironmentOptions, "allowedFeatures" | "startupTimeoutMs" | "executionTimeoutMs" | "signal">;
}

function fail(message: string): never { throw new Error(message); }
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("numeric profile expects a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("numeric profile expects a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !required.includes(key) && !optional.includes(key)) || required.some((key) => !keys.includes(key))) {
    return fail("numeric profile has unknown or missing fields");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("numeric profile fields must be data properties");
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("numeric profile expects an array");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(value).length !== length + 1) return fail("invalid numeric profile array");
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("invalid numeric profile array entry");
    return descriptor.value;
  });
}
function name(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > 4096) return fail("invalid numeric profile name");
  return value;
}
function limit(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return fail("invalid numeric resource limit");
  return value as number;
}
function interfaceContract(value: unknown): ModuleInterface {
  const item = fields(value, ["name", "version"]);
  const version = limit(item.version, 0xffff_ffff);
  if (version === 0) return fail("invalid numeric interface version");
  return { name: name(item.name), version };
}
function functionContracts(value: unknown, allowVoid: boolean, budget: { entries: number }): NumericFunctionContract[] {
  const names = new Set<string>();
  const entries = list(value, 4096);
  budget.entries += entries.length;
  if (budget.entries > 100_000) return fail("numeric profile entry limit exceeded");
  return entries.map((entry) => {
    const item = fields(entry, ["name", "params", "results"]), itemName = name(item.name);
    if (names.has(itemName) || reserved.has(itemName)) return fail(`invalid numeric function contract ${JSON.stringify(itemName)}`);
    names.add(itemName);
    const params = list(item.params, 64), results = list(item.results, 1);
    budget.entries += params.length + results.length;
    if (budget.entries > 100_000) return fail("numeric profile entry limit exceeded");
    if (params.some((type) => type !== "i32") || results.some((type) => type !== "i32") || (!allowVoid && results.length !== 1)) {
      return fail(`unsupported numeric function signature ${JSON.stringify(itemName)}`);
    }
    return { name: itemName, params: params as "i32"[], results: results as "i32"[] };
  });
}
function sameInterface(a: ModuleInterface, b: ModuleInterface): boolean { return a.name === b.name && a.version === b.version; }
function sameFunction(a: NumericFunctionContract, b: ModuleExport): boolean {
  return b.kind === "function" && a.params.length === b.params.length && a.results.length === b.results.length
    && b.params.every((value) => value === "i32") && b.results.every((value) => value === "i32");
}
function wasiSignature(service: NumericWasiService, value: ModuleExport): boolean {
  if (value.kind !== "function" || !Object.hasOwn(NUMERIC_WASI_SIGNATURES, service)) return false;
  const encode = (types: readonly string[]) => types.map((type) => type === "i32" ? "i" : type === "i64" ? "I" : "?").join("");
  return `${encode(value.params)}/${encode(value.results)}` === NUMERIC_WASI_SIGNATURES[service];
}
function lvglSignature(value: ModuleExport): boolean {
  if (value.kind !== "function" || !Object.hasOwn(lvglCallbacks, value.name)) return false;
  const encode = (types: readonly string[]) => types.map((type) => type === "i32" ? "i" : "?").join("");
  return `${encode(value.params)}/${encode(value.results)}` === lvglCallbacks[value.name];
}
function labelSignature(value: ModuleExport, events: boolean): boolean {
  if (value.kind !== "function") return false;
  const signature = Object.hasOwn(labelImports, value.name) ? labelImports[value.name]
    : events && Object.hasOwn(eventImports, value.name) ? eventImports[value.name] : undefined;
  if (signature === undefined) return false;
  const encode = (types: readonly string[]) => types.map((type) => type === "i32" ? "i" : "?").join("");
  return `${encode(value.params)}/${encode(value.results)}` === signature;
}
function ownMemory(record: NumericRecord): void {
  if (record.facts.memories.length !== 1 || record.facts.memories[0]!.imported || record.facts.memories[0]!.type.shared
      || !record.facts.exports.some((item) => item.kind === "memory" && item.name === "memory" && item.index === 0)) {
    fail(`${JSON.stringify(record.manifest.id)}: label profile requires owned exported memory`);
  }
}
function ownEntrypoint(record: NumericRecord, entry: string, params: readonly string[], results: readonly string[], required: boolean): void {
  const item = record.facts.exports.find((value) => value.name === entry);
  if (!item) { if (required) fail(`${JSON.stringify(record.manifest.id)}: missing ${entry}`); return; }
  if (item.kind !== "function" || record.facts.functions[item.index]?.imported) fail(`${JSON.stringify(record.manifest.id)}: ${entry} must be an owned function`);
  const signature = record.facts.types[item.typeIndex]!;
  if (signature.params.join() !== params.join() || signature.results.join() !== results.join()) fail(`${JSON.stringify(record.manifest.id)}: invalid ${entry} signature`);
}

/** @internal Snapshot the trusted numeric profile and match it to the prepared graph. */
export function prepareNumericProfile(prepared: PreparedModuleGraph, options: NumericEnvironmentOptions): NumericProfile {
  const root = fields(options, ["profile", "modules", "hosts", "allowedFeatures", "startupTimeoutMs", "executionTimeoutMs",
    "maxMemoryPages", "maxTotalMemoryPages", "maxTableElements", "maxTotalTableElements"], ["signal", "wasi", "lvgl", "label", "event"]);
  if (root.profile !== "numeric-v1" && root.profile !== "lvgl-core-v1" && root.profile !== "lvgl-label-v1" && root.profile !== "lvgl-event-v1") return fail("unsupported numeric profile");
  if (root.profile === "numeric-v1" && Object.hasOwn(root, "lvgl")) return fail("numeric-v1 does not accept an LVGL core");
  if (root.profile !== "lvgl-label-v1" && root.profile !== "lvgl-event-v1" && Object.hasOwn(root, "label")) return fail("label adapter requires an LVGL label profile");
  if (root.profile !== "lvgl-event-v1" && Object.hasOwn(root, "event")) return fail("event adapter requires lvgl-event-v1");
  let lvgl: NumericProfile["lvgl"];
  if (root.profile === "lvgl-core-v1" || root.profile === "lvgl-label-v1" || root.profile === "lvgl-event-v1") {
    const value = fields(root.lvgl, ["module", "id", "interface", "abiVersion"]);
    if (value.abiVersion !== 1) return fail("unsupported LVGL bridge ABI");
    lvgl = { module: name(value.module), id: name(value.id), interface: interfaceContract(value.interface), abiVersion: 1 };
  }
  let label: NumericProfile["label"];
  let selectedConsumer: string | undefined;
  if (root.profile === "lvgl-label-v1" || root.profile === "lvgl-event-v1") {
    const value = fields(root.label, ["id", "interface", "width", "height", "maxLabels", "maxTextBytes"], ["consumer"]);
    selectedConsumer = Object.hasOwn(value, "consumer") ? name(value.consumer) : undefined;
    const width = limit(value.width, 4096), height = limit(value.height, 4096);
    const maxLabels = limit(value.maxLabels, 4096), maxTextBytes = limit(value.maxTextBytes, 1024 * 1024);
    if (!width || !height || width * height * 4 > 16 * 1024 * 1024 || !maxLabels || !maxTextBytes) fail("invalid LVGL label limits");
    label = { id: name(value.id), interface: interfaceContract(value.interface), width, height, maxLabels, maxTextBytes };
  }
  let event: NumericProfile["event"];
  if (root.profile === "lvgl-event-v1") {
    const value = fields(root.event, ["maxRegistrations", "maxDepth"]);
    const maxRegistrations = limit(value.maxRegistrations, 4096), maxDepth = limit(value.maxDepth, 64);
    if (!maxRegistrations || !maxDepth) fail("invalid LVGL event limits");
    event = { maxRegistrations, maxDepth };
  }
  const budget = { entries: 0 };
  const modules = new Map<string, NumericModuleContract>();
  for (const value of list(root.modules, 256)) {
    const item = fields(value, ["id", "sha256", "interface", "exports"]), id = name(item.id);
    if (modules.has(id) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return fail(`invalid numeric module identity ${JSON.stringify(id)}`);
    modules.set(id, { id, sha256: item.sha256, interface: interfaceContract(item.interface), exports: functionContracts(item.exports, false, budget) });
  }
  const hosts = new Map<string, NumericHostContract>();
  for (const value of list(root.hosts, 256)) {
    const item = fields(value, ["id", "interface", "exports", "create"]), id = name(item.id);
    if (hosts.has(id) || typeof item.create !== "function") return fail(`invalid numeric host ${JSON.stringify(id)}`);
    hosts.set(id, { id, interface: interfaceContract(item.interface), exports: functionContracts(item.exports, true, budget), create: item.create as NumericHostContract["create"] });
  }
  const wasi = root.wasi === undefined ? undefined : prepareNumericWasi(root.wasi);
  if (wasi && hosts.has(wasi.id)) fail("numeric WASI provider conflicts with a numeric host");
  if (lvgl && (hosts.has(lvgl.id) || wasi?.id === lvgl.id || modules.has(lvgl.id))) fail("LVGL host provider identity conflicts");
  if (label && (hosts.has(label.id) || wasi?.id === label.id || lvgl?.id === label.id || modules.has(label.id))) fail("LVGL label provider identity conflicts");
  const allowedFeatures = list(root.allowedFeatures, 32).map(name);
  const featureOptions = { allowedFeatures, startupTimeoutMs: root.startupTimeoutMs as number, executionTimeoutMs: root.executionTimeoutMs as number,
    signal: root.signal as AbortSignal | undefined };
  const maxMemoryPages = limit(root.maxMemoryPages, 65536), maxTotalMemoryPages = limit(root.maxTotalMemoryPages, 65536 * 256);
  const maxTableElements = limit(root.maxTableElements, 0xffff_ffff), maxTotalTableElements = limit(root.maxTotalTableElements, 0xffff_ffff * 256);
  if (modules.size !== prepared.modules.length || hosts.size + Number(wasi !== undefined) + Number(lvgl !== undefined) + Number(label !== undefined) !== prepared.hosts.length) return fail("numeric profile provider inventory differs");
  if (selectedConsumer !== undefined && (!modules.has(selectedConsumer) || selectedConsumer === lvgl?.module)) return fail("invalid LVGL label consumer");
  let totalMemory = 0, totalTables = 0;
  let app: string | undefined, foundLvgl = false;
  for (const record of prepared.modules) {
    const current = record.manifest, contract = modules.get(current.id);
    if (!contract || contract.sha256 !== record.facts.sha256 || !sameInterface(contract.interface, current.interface)) fail(`${JSON.stringify(current.id)}: numeric module is not authorized`);
    if (current.role === "app") { if (app !== undefined) fail("numeric profile requires exactly one app"); app = current.id; }
    if (record.facts.imports.some((item) => item.module === "wasi_unstable" || item.module.startsWith("wasi:") || item.module === "wasi_snapshot_preview1" && !wasi)) {
      fail(`${JSON.stringify(current.id)}: WASI imports are unsupported by numeric-v1`);
    }
    if (record.facts.exports.some((item) => item.name === "_start")) fail(`${JSON.stringify(current.id)}: _start is unsupported by numeric-v1`);
    const isLvgl = lvgl?.module === current.id;
    if (isLvgl) {
      if (current.role !== "lib") fail("LVGL core must be a library");
      foundLvgl = true;
      ownEntrypoint(record, "_initialize", [], [], true);
      for (const entry of lvglLifecycle) ownEntrypoint(record, entry, [], ["i32"], true);
      if (contract.exports.some((fn) => lvglLifecycle.has(fn.name))) fail("LVGL lifecycle exports cannot be authorized as business functions");
      if (contract.exports.some((fn) => !lvglScalars.has(fn.name) || fn.params.length !== 0 || fn.results.length !== 1)) {
        fail("unsupported LVGL scalar export");
      }
      if (label) {
        ownMemory(record);
        for (const [entry, params, results] of [
          ["lvw_display_create", ["i32", "i32", "i32"], ["i32"]], ["lvw_alloc", ["i32"], ["i32"]], ["lvw_free", ["i32"], []],
          ["lv_display_get_screen_active", ["i32"], ["i32"]], ["lv_label_create", ["i32"], ["i32"]], ["lv_label_set_text", ["i32", "i32"], []],
          ["lv_refr_now", ["i32"], []], ["lvw_frame_get", ["i32", "i32"], ["i32"]],
        ] as const) ownEntrypoint(record, entry, params, results, true);
      }
      if (event) {
        for (const [entry, params, results] of [
          ["lvw_event_clicked", [], ["i32"]], ["lvw_event_current", [], ["i32"]],
          ["lvw_event_add", ["i32", "i32", "i32"], ["i32"]], ["lvw_event_remove", ["i32", "i32"], ["i32"]],
          ["lv_obj_send_event", ["i32", "i32", "i32"], ["i32"]], ["lv_event_get_target_obj", ["i32"], ["i32"]],
        ] as const) ownEntrypoint(record, entry, params, results, true);
      }
    } else {
      ownEntrypoint(record, "_initialize", [], [], false);
      ownEntrypoint(record, "module_init", [], ["i32"], true);
      ownEntrypoint(record, "module_close", [], ["i32"], true);
    }
    if (current.role === "app") {
      ownEntrypoint(record, "app_run", ["i32"], ["i32"], true);
      if (event) {
        ownEntrypoint(record, eventDispatch, ["i32", "i32"], [], true);
        if (record.facts.tables.length !== 1 || record.facts.tables[0]!.imported) fail("LVGL event app requires its own table");
        if (contract.exports.some((fn) => fn.name === eventDispatch)) fail("LVGL event dispatcher cannot be a business export");
      }
    }
    if (label && (selectedConsumer === current.id || selectedConsumer === undefined && current.role === "app")) {
      ownMemory(record);
      if (!current.requires.some((requirement) => requirement.provider === lvgl!.module)) {
        fail(current.role === "app" ? "label app must depend on its LVGL core" : "label consumer must depend on its LVGL core");
      }
      if (selectedConsumer !== undefined && !current.requires.some((requirement) => requirement.provider === label!.id)) {
        fail("label consumer must depend on its label provider");
      }
      if (selectedConsumer !== undefined) {
        const imported = new Set(record.facts.imports.filter((item) => item.kind === "function" && item.module === "lvgl")
          .map((item) => item.index));
        if (record.facts.exports.some((item) => item.kind === "function" && imported.has(item.index))) {
          fail(`${JSON.stringify(current.id)}: LVGL label imports cannot be re-exported`);
        }
      }
    }
    for (const memory of record.facts.memories) {
      const max = memory.type.maximumPages;
      if (max === null || max > maxMemoryPages) fail(`${JSON.stringify(current.id)}: numeric memory limit exceeded`);
      totalMemory += max;
    }
    for (const table of record.facts.tables) {
      const max = table.type.maximum;
      if (max === null || max > maxTableElements) fail(`${JSON.stringify(current.id)}: numeric table limit exceeded`);
      totalTables += max;
    }
    for (const fn of contract.exports) {
      const actual = current.exports.find((item) => item.name === fn.name);
      if (!actual || !sameFunction(fn, actual)) fail(`${JSON.stringify(current.id)}: numeric export contract differs for ${JSON.stringify(fn.name)}`);
    }
  }
  if (lvgl && !foundLvgl) return fail("LVGL core module is missing");
  if (app === undefined) return fail("numeric profile requires exactly one app");
  const labelConsumer = selectedConsumer ?? app;
  if (event && labelConsumer !== app) return fail("LVGL event consumer must be its app");
  if (totalMemory > maxTotalMemoryPages || totalTables > maxTotalTableElements) return fail("numeric environment resource limit exceeded");
  for (const host of prepared.hosts) {
    if (label && host.id === label.id) {
      if (!sameInterface(label.interface, host.interface) || host.exports.some((item) => !labelSignature(item, !!event))) fail("LVGL label host contract differs");
      continue;
    }
    if (lvgl && host.id === lvgl.id) {
      if (!sameInterface(lvgl.interface, host.interface) || host.exports.some((item) => !lvglSignature(item))) fail("LVGL host contract differs");
      continue;
    }
    if (wasi && host.id === wasi.id) {
      if (!sameInterface(wasi.interface, host.interface) || host.exports.length !== wasi.allowed.length) fail("numeric WASI host contract differs");
      for (const item of host.exports) {
        const service = item.name as NumericWasiService;
        if (!wasi.allowed.includes(service) || !wasiSignature(service, item)) fail("numeric WASI host export differs");
      }
      continue;
    }
    const contract = hosts.get(host.id);
    if (!contract || !sameInterface(contract.interface, host.interface) || contract.exports.length !== host.exports.length) fail(`${JSON.stringify(host.id)}: numeric host contract differs`);
    for (const fn of contract.exports) {
      const actual = host.exports.find((item) => item.name === fn.name);
      if (!actual || !sameFunction(fn, actual)) fail(`${JSON.stringify(host.id)}: numeric host export differs for ${JSON.stringify(fn.name)}`);
    }
  }
  const lvglImports = new Set<string>();
  const labelUsed = new Set<string>();
  for (const record of prepared.modules) for (const requirement of record.manifest.requires) {
    if (lvgl && requirement.provider === lvgl.id && record.manifest.id !== lvgl.module) fail("LVGL host is reserved for its core");
    if (label && requirement.provider === label.id && record.manifest.id !== labelConsumer) {
      fail(selectedConsumer === undefined ? "LVGL label host is reserved for its app" : "LVGL label host is reserved for its consumer");
    }
    for (const item of requirement.imports) {
      if (label && (item.module === "lvgl" || requirement.provider === label.id)) {
        if (record.manifest.id !== labelConsumer || requirement.provider !== label.id || item.module !== "lvgl"
            || item.provider_export !== item.name || !labelSignature(item, !!event)) fail(`${JSON.stringify(record.manifest.id)}: LVGL label import is not authorized`);
        labelUsed.add(item.name);
        continue;
      }
      if (lvgl && (item.module === "lvw" || requirement.provider === lvgl.id)) {
        if (record.manifest.id !== lvgl.module || requirement.provider !== lvgl.id || item.module !== "lvw"
            || item.provider_export !== item.name || !lvglSignature(item)) fail(`${JSON.stringify(record.manifest.id)}: LVGL host import is not authorized`);
        lvglImports.add(item.name);
        continue;
      }
      if (item.module === "wasi_snapshot_preview1" || wasi && requirement.provider === wasi.id) {
        const service = item.name as NumericWasiService;
        if (!wasi || requirement.provider !== wasi.id || item.module !== "wasi_snapshot_preview1" || item.provider_export !== item.name
            || !wasi.allowed.includes(service) || !wasiSignature(service, item)) fail(`${JSON.stringify(record.manifest.id)}: numeric WASI import is not authorized`);
        continue;
      }
      if (item.kind !== "function" || reserved.has(item.provider_export)
          || lvgl && requirement.provider === lvgl.module && lvglLifecycle.has(item.provider_export)
          || event && requirement.provider === app && item.provider_export === eventDispatch) fail(`${JSON.stringify(record.manifest.id)}: unsupported numeric import`);
      const provider = modules.get(requirement.provider) ?? hosts.get(requirement.provider);
      const contract = provider?.exports.find((fn) => fn.name === item.provider_export);
      if (!contract || !sameFunction(contract, { ...item, name: item.name })) fail(`${JSON.stringify(record.manifest.id)}: numeric import is not authorized`);
    }
  }
  if (lvgl) {
    const host = prepared.hosts.find((item) => item.id === lvgl!.id)!;
    if (host.exports.length !== lvglImports.size || host.exports.some((item) => !lvglImports.has(item.name))) fail("LVGL host inventory differs from core imports");
    if (event && !lvglImports.has("event")) fail("LVGL event profile requires the core event import");
  }
  if (label) {
    const host = prepared.hosts.find((item) => item.id === label!.id)!;
    if (host.exports.length !== labelUsed.size || host.exports.some((item) => !labelUsed.has(item.name))) {
      fail(labelConsumer === app ? "LVGL label host inventory differs from app imports" : "LVGL label host inventory differs from consumer imports");
    }
  }
  return { modules, hosts, wasi, lvgl, label, event, app, labelConsumer: label ? labelConsumer : undefined, featureOptions };
}

/** @internal Compile all private snapshots before creating any guest instance. */
export function compileNumericModules(prepared: PreparedModuleGraph): ReadonlyMap<string, WebAssembly.Module> {
  const compiled = new Map<string, WebAssembly.Module>();
  for (const record of prepared.modules) {
    try { compiled.set(record.manifest.id, new WasmModule(record.bytes)); }
    catch (error) { throw new Error(`${JSON.stringify(record.manifest.id)}: current engine compilation failed: ${String(error)}`); }
  }
  return compiled;
}

interface LiveModule { readonly record: NumericRecord; instance?: WebAssembly.Instance; initialized: boolean }
interface LiveHost { readonly exports: Readonly<Record<string, (...args: number[]) => number | void>>; readonly close: () => void }

function i32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff;
}
function reserveLabelToken(): number {
  if (nextLabelToken > 0xffff_ffff) return fail("LVGL label tokens exhausted");
  return nextLabelToken++;
}

/** A numeric-v1 environment with private module instances. */
export interface NumericEnvironment {
  readonly state: "loading" | "ready" | "closing" | "closed" | "poisoned";
  run(value: number): number;
  close(): void;
  readonly readFrame?: () => { readonly width: number; readonly height: number; readonly frameId: number; readonly rgba: Uint8ClampedArray<ArrayBuffer> };
}

class LabelAdapter {
  #core?: WebAssembly.Instance;
  #appMemory?: WebAssembly.Memory;
  #handles = new Map<number, { readonly kind: "screen" | "label"; readonly pointer: number }>();
  #screen = 0;
  #labels = 0;

  constructor(core: WebAssembly.Instance, appMemory: WebAssembly.Memory, readonly display: number,
    readonly options: NonNullable<NumericProfile["label"]>, private readonly rethrow: () => void) {
    this.#core = core;
    this.#appMemory = appMemory;
  }

  #call(name: string, ...args: number[]): number | void {
    const fn = this.#core?.exports[name];
    if (typeof fn !== "function") return fail("LVGL label adapter is unavailable");
    const result = fn(...args) as number | void;
    this.rethrow();
    return result;
  }

  #memory(): Uint8Array<ArrayBuffer> {
    const memory = this.#core?.exports.memory;
    if (!(memory instanceof WebAssembly.Memory) || !(memory.buffer instanceof ArrayBuffer)) return fail("LVGL core memory is unavailable");
    return new Uint8Array(memory.buffer);
  }

  #handle(token: number, kind: "screen" | "label"): number {
    const record = this.#handles.get(token >>> 0);
    if (!record || record.kind !== kind) return fail("invalid LVGL label handle");
    return record.pointer;
  }

  eventTarget(token: number): number { return this.#handle(token, "label"); }

  screen(): number {
    const pointer = (this.#call("lv_display_get_screen_active", this.display) as number) >>> 0;
    if (!pointer) return fail("LVGL screen is unavailable");
    if (this.#screen) {
      if (this.#handle(this.#screen, "screen") !== pointer) return fail("LVGL screen changed");
      return this.#screen;
    }
    const token = reserveLabelToken();
    this.#handles.set(token, { kind: "screen", pointer });
    this.#screen = token;
    return token;
  }

  create(parent: number): number {
    const pointer = this.#handle(parent, "screen");
    if (this.#labels >= this.options.maxLabels) return fail("LVGL label quota exceeded");
    const token = reserveLabelToken();
    const created = (this.#call("lv_label_create", pointer) as number) >>> 0;
    if (!created) return 0;
    this.#handles.set(token, { kind: "label", pointer: created });
    this.#labels++;
    return token;
  }

  setText(token: number, address: number): void {
    const pointer = this.#handle(token, "label");
    const offset = address >>> 0;
    if (offset === 0) { this.#call("lv_label_set_text", pointer, 0); return; }
    const buffer = this.#appMemory?.buffer;
    if (!(buffer instanceof ArrayBuffer)) return fail("LVGL app memory is unavailable");
    const bytes = new Uint8Array(buffer);
    if (offset >= bytes.length) return fail("LVGL text pointer is out of bounds");
    const end = Math.min(bytes.length, offset + this.options.maxTextBytes + 1);
    let cursor = offset;
    while (cursor < end && bytes[cursor] !== 0) cursor++;
    if (cursor === end || cursor - offset > this.options.maxTextBytes) return fail("LVGL text is unterminated or too long");
    const snapshot = bytes.slice(offset, cursor + 1);
    const scratch = (this.#call("lvw_alloc", snapshot.length) as number) >>> 0;
    if (!scratch) return fail("LVGL text allocation failed");
    const memory = this.#memory();
    if (scratch > memory.length || snapshot.length > memory.length - scratch) return fail("LVGL text allocation is out of bounds");
    memory.set(snapshot, scratch);
    this.#call("lv_label_set_text", pointer, scratch);
    this.#call("lvw_free", scratch);
  }

  frame(): NonNullable<NumericEnvironment["readFrame"]> extends () => infer T ? T : never {
    this.#call("lv_refr_now", this.display);
    const scratch = (this.#call("lvw_alloc", 48) as number) >>> 0;
    if (!scratch) return fail("LVGL frame allocation failed");
    let memory = this.#memory();
    if (scratch > memory.length || 48 > memory.length - scratch) return fail("LVGL frame allocation is out of bounds");
    memory.fill(0, scratch, scratch + 48);
    let view = new DataView(memory.buffer);
    view.setUint32(scratch, 48, true);
    view.setUint32(scratch + 4, 1, true);
    if (this.#call("lvw_frame_get", this.display, scratch) !== 0) return fail("LVGL frame is unavailable");
    memory = this.#memory();
    if (scratch > memory.length || 48 > memory.length - scratch) return fail("LVGL frame metadata is out of bounds");
    view = new DataView(memory.buffer);
    const size = view.getUint32(scratch, true), version = view.getUint32(scratch + 4, true);
    const pointer = view.getUint32(scratch + 8, true), length = view.getUint32(scratch + 12, true);
    const width = view.getUint32(scratch + 16, true), height = view.getUint32(scratch + 20, true);
    const stride = view.getUint32(scratch + 24, true), format = view.getUint32(scratch + 28, true);
    const alpha = view.getUint32(scratch + 32, true), frameId = view.getUint32(scratch + 44, true);
    if (size !== 48 || version !== 1 || width !== this.options.width || height !== this.options.height
        || stride !== width * 4 || length !== stride * height || format !== 1 || alpha !== 0 || pointer === 0
        || pointer > memory.length || length > memory.length - pointer) return fail("invalid LVGL frame metadata");
    const rgba = new Uint8ClampedArray(length);
    for (let index = 0; index < length; index += 4) {
      rgba[index] = memory[pointer + index + 2]!; rgba[index + 1] = memory[pointer + index + 1]!;
      rgba[index + 2] = memory[pointer + index]!; rgba[index + 3] = 255;
    }
    this.#call("lvw_free", scratch);
    return { width, height, frameId, rgba };
  }

  close(): void { this.#handles.clear(); this.#appMemory = undefined; this.#core = undefined; }
}

class NumericRuntime {
  #state: "loading" | "ready" | "closing" | "closed" | "poisoned" = "loading";
  #failure: unknown;
  #depth = 0;
  #modules = new Map<string, LiveModule>();
  #wasi = new Map<string, ReturnType<typeof createNumericWasiConsumer>>();
  #initialized: LiveModule[] = [];
  #hosts: LiveHost[] = [];
  #label?: LabelAdapter;
  #event?: EventAdapter;
  #app: string;
  #lvgl?: string;

  constructor(app: string, lvgl?: string) { this.#app = app; this.#lvgl = lvgl; }
  get state(): "loading" | "ready" | "closing" | "closed" | "poisoned" { return this.#state; }

  #poison(error: unknown): never {
    if (this.#state !== "poisoned") { this.#state = "poisoned"; this.#failure = error; }
    throw this.#failure;
  }
  #rethrow(): void { if (this.#state === "poisoned") throw this.#failure; }
  #enter<T>(call: () => T): T {
    this.#rethrow();
    if (this.#state === "closed") return fail("numeric environment is closed");
    this.#depth++;
    let result: T | undefined;
    try { result = call(); this.#rethrow(); }
    catch (error) { if (this.#state !== "poisoned") { this.#state = "poisoned"; this.#failure = error; } }
    finally {
      this.#depth--;
      if (this.#depth === 0 && this.#state === "poisoned") {
        const cleanup = this.#releaseHosts();
        if (cleanup.length) this.#failure = new AggregateError([this.#failure, ...cleanup], "numeric environment cleanup failed");
        this.#invalidateModules();
      }
    }
    this.#rethrow();
    return result as T;
  }
  #releaseHosts(): unknown[] {
    const errors: unknown[] = [];
    for (const host of this.#hosts.splice(0).reverse()) {
      try {
        const close = host.close;
        const result = close();
        if (result !== undefined) throw new Error("numeric host close must return undefined");
      } catch (error) { errors.push(error); }
    }
    return errors;
  }
  #invalidateModules(): void {
    this.#event?.discard();
    this.#event = undefined;
    this.#label?.close();
    this.#label = undefined;
    for (const wasi of this.#wasi.values()) wasi.close();
    this.#wasi.clear();
    for (const module of this.#modules.values()) { module.instance = undefined; module.initialized = false; }
    this.#initialized.length = 0;
    this.#modules.clear();
  }
  #idle(operation: string): void {
    if (this.#depth !== 0) this.#poison(new Error(`${operation} is not reentrant`));
    this.#rethrow();
    if (this.#state !== "ready") fail(`numeric environment is ${this.#state}`);
  }
  #closeInitialized(): void {
    while (this.#initialized.length) {
      const module = this.#initialized[this.#initialized.length - 1]!;
      const closeName = module.record.manifest.id === this.#lvgl ? "lvw_shutdown" : "module_close";
      const close = module.instance!.exports[closeName] as () => number;
      const status = this.#enter(close);
      if (status !== 0) this.#poison(new Error(`${JSON.stringify(module.record.manifest.id)}: ${closeName} returned ${status}`));
      if (module.record.manifest.id === this.#app) {
        if (this.#event) this.#enter(() => this.#event!.close());
        this.#event = undefined;
        this.#label?.close(); this.#label = undefined;
      }
      this.#wasi.get(module.record.manifest.id)?.close();
      this.#wasi.delete(module.record.manifest.id);
      module.initialized = false;
      this.#initialized.pop();
    }
  }

  /** Run the selected app with one signed i32 value. */
  run(value: number): number {
    this.#idle("run");
    if (!i32(value)) return fail("numeric app input must be a signed i32");
    return this.#enter(() => (this.#modules.get(this.#app)!.instance!.exports.app_run as (value: number) => number)(value));
  }

  readFrame(): ReturnType<NonNullable<NumericEnvironment["readFrame"]>> {
    this.#idle("readFrame");
    if (!this.#label) return fail("LVGL label adapter is unavailable");
    return this.#enter(() => this.#label!.frame());
  }

  /** Close the app and initialized libraries in reverse dependency order. */
  close(): void {
    this.#idle("close");
    this.#state = "closing";
    try {
      this.#closeInitialized();
      const errors = this.#releaseHosts();
      if (errors.length) this.#poison(new AggregateError(errors, "numeric host cleanup failed"));
      this.#invalidateModules();
      this.#state = "closed";
    } catch (error) {
      const cleanup = this.#releaseHosts();
      if (cleanup.length) this.#failure = new AggregateError([this.state === "poisoned" ? this.#failure : error, ...cleanup], "numeric environment cleanup failed");
      if (cleanup.length) this.#state = "poisoned";
      this.#invalidateModules();
      return this.#poison(error);
    }
  }

  /** @internal Instantiate only after the complete graph has passed preflight and compilation. */
  static load(prepared: PreparedModuleGraph, profile: NumericProfile, compiled: ReadonlyMap<string, WebAssembly.Module>, beforeGuest: () => void): NumericRuntime {
    const environment = new NumericRuntime(profile.app, profile.lvgl?.module);
    const environmentId = Symbol("numeric environment");
    const wasiBudget = createNumericWasiBudget();
    const hostBindings = new Map<string, Map<string, LiveHost>>();
    try {
      for (const record of prepared.modules) environment.#modules.set(record.manifest.id, { record, initialized: false });
      for (const id of prepared.order) {
        const record = environment.#modules.get(id)!.record;
        const byHost = new Map<string, LiveHost>();
        for (const requirement of record.manifest.requires) {
          if (profile.wasi && requirement.provider === profile.wasi.id) {
            if (requirement.imports.length && !environment.#wasi.has(id)) environment.#wasi.set(id, createNumericWasiConsumer(profile.wasi, id, wasiBudget, () => environment.#rethrow(), environmentId));
            continue;
          }
          if (profile.lvgl && requirement.provider === profile.lvgl.id) continue;
          if (profile.label && requirement.provider === profile.label.id) continue;
          const contract = profile.hosts.get(requirement.provider);
          if (!contract || byHost.has(contract.id)) continue;
          const create = contract.create;
          const created = create(record.manifest.id, environmentId);
          let host: { exports: LiveHost["exports"]; close: () => void } | undefined;
          if (created !== null && typeof created === "object" && !Array.isArray(created)) {
            const prototype = Object.getPrototypeOf(created);
            const close = Object.getOwnPropertyDescriptor(created, "close");
            if ((prototype === Object.prototype || prototype === null) && close && "value" in close && close.enumerable && typeof close.value === "function") {
              host = { exports: Object.create(null), close: close.value as () => void };
              environment.#hosts.push(host);
            }
          }
          const instance = fields(created, ["exports", "close"]);
          if (!host) fail(`${JSON.stringify(contract.id)}: invalid host close`);
          const exports = fields(instance.exports, contract.exports.map((fn) => fn.name));
          for (const fn of contract.exports) if (typeof exports[fn.name] !== "function") fail(`${JSON.stringify(contract.id)}: missing host function ${JSON.stringify(fn.name)}`);
          host.exports = exports as LiveHost["exports"];
          byHost.set(contract.id, host);
          beforeGuest();
        }
        hostBindings.set(record.manifest.id, byHost);
      }
      beforeGuest();
      for (const id of prepared.order) {
        const live = environment.#modules.get(id)!;
        const imports: Record<string, Record<string, WebAssembly.ImportValue>> = Object.create(null);
        for (const requirement of live.record.manifest.requires) for (const item of requirement.imports) {
          const namespace = imports[item.module] ?? (imports[item.module] = Object.create(null));
          if (Object.hasOwn(namespace, item.name)) continue;
          if (profile.wasi && requirement.provider === profile.wasi.id) {
            const callback = environment.#wasi.get(id)!.exports[item.name as NumericWasiService] as ((...args: (number | bigint)[]) => number | void) | undefined;
            if (!callback) fail(`${JSON.stringify(id)}: missing numeric WASI service`);
            namespace[item.name] = (...args: (number | bigint)[]) => environment.#enter(() => callback(...args));
            continue;
          }
          if (profile.lvgl && requirement.provider === profile.lvgl.id) {
            if (profile.event && item.name === "event") {
              namespace[item.name] = (id: number, target: number, code: number) => environment.#enter(() => {
                if (!environment.#event) return fail("LVGL event adapter is unavailable");
                environment.#event.dispatch(id, target, code);
              });
            } else namespace[item.name] = () => environment.#enter(() => fail(`unsupported LVGL callback ${JSON.stringify(item.name)}`));
            continue;
          }
          if (profile.label && requirement.provider === profile.label.id) {
            namespace[item.name] = (...args: number[]) => environment.#enter(() => {
              const adapter = environment.#label;
              if (!adapter) return fail("LVGL label adapter is unavailable");
              if (item.name === "lv_screen_active") return adapter.screen();
              if (item.name === "lv_label_create") return adapter.create(args[0]!);
              if (item.name === "lv_label_set_text") return adapter.setText(args[0]!, args[1]!);
              const event = environment.#event;
              if (!event) return fail("LVGL event adapter is unavailable");
              if (item.name === "lv_obj_add_event_cb") return event.add(args[0]!, args[1]!, args[2]!, args[3]!);
              if (item.name === "lv_obj_remove_event_dsc") return event.remove(args[0]!, args[1]!);
              if (item.name === "lv_obj_send_event") return event.send(args[0]!, args[1]!, args[2]!);
              if (item.name === "lv_event_get_code") return event.code(args[0]!);
              if (item.name === "lv_event_get_user_data") return event.user(args[0]!);
              if (item.name === "lv_event_get_target_obj") return event.target(args[0]!);
              return fail("unsupported LVGL label import");
            });
            continue;
          }
          const host = hostBindings.get(id)!.get(requirement.provider);
          const contract = (profile.modules.get(requirement.provider) ?? profile.hosts.get(requirement.provider))!.exports.find((fn) => fn.name === item.provider_export)!;
          if (host) {
            const callback = host.exports[item.provider_export]!;
            namespace[item.name] = (...args: number[]) => environment.#enter(() => {
              const value = callback(...args);
              if (contract.results.length ? !i32(value) : value !== undefined) fail(`${JSON.stringify(requirement.provider)}: invalid host result`);
              return value;
            });
          } else {
            const provider = environment.#modules.get(requirement.provider)!;
            namespace[item.name] = (...args: number[]) => environment.#enter(() => {
              if (!provider.initialized || !provider.instance) fail(`${JSON.stringify(requirement.provider)}: numeric provider is not initialized`);
              return (provider.instance.exports[item.provider_export] as (...args: number[]) => number)(...args);
            });
          }
        }
        live.instance = new WasmInstance(compiled.get(id)!, imports);
        const wasi = environment.#wasi.get(id);
        if (wasi) {
          const memory = live.instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) fail(`${JSON.stringify(id)}: numeric WASI memory is unavailable`);
          wasi.bind(memory);
        }
        const rollback = (failure: Error): never => {
          if (id === profile.app) {
            try { if (environment.#event) environment.#enter(() => environment.#event!.close()); }
            catch (error) { throw new AggregateError([failure, error], "numeric initialization rollback failed"); }
            environment.#event = undefined;
            environment.#label?.close(); environment.#label = undefined;
          }
          environment.#wasi.get(id)?.close();
          environment.#wasi.delete(id);
          environment.#state = "closing";
          try { environment.#closeInitialized(); }
          catch (error) { throw new AggregateError([failure, error], "numeric initialization rollback failed"); }
          throw failure;
        };
        if (profile.label && id === profile.app) {
          const provider = environment.#modules.get(profile.lvgl!.module)!;
          if (!provider.initialized || !provider.instance) fail("LVGL core is not initialized");
          const memory = live.instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) fail("LVGL app memory is unavailable");
          const display = environment.#enter(() => (provider.instance!.exports.lvw_display_create as (width: number, height: number, format: number) => number)(profile.label!.width, profile.label!.height, 1)) >>> 0;
          if (!display) rollback(new Error("LVGL display creation failed"));
          environment.#label = new LabelAdapter(provider.instance, memory, display, profile.label, () => environment.#rethrow());
          if (profile.event) {
            const clicked = environment.#enter(() => (provider.instance!.exports.lvw_event_clicked as () => number)()) >>> 0;
            if (!clicked) rollback(new Error("LVGL clicked event code is unavailable"));
            environment.#event = new EventAdapter(provider.instance, live.instance, environment.#label, clicked, profile.event, () => environment.#rethrow(), reserveLabelToken);
          }
        }
        const initialize = live.instance.exports._initialize;
        if (typeof initialize === "function") environment.#enter(() => initialize());
        const isLvgl = id === profile.lvgl?.module;
        if (isLvgl) {
          const version = environment.#enter(() => (live.instance!.exports.lvw_abi_version as () => number)());
          if (version !== profile.lvgl!.abiVersion) rollback(new Error(`${JSON.stringify(id)}: unsupported LVGL bridge ABI ${version}`));
        }
        const initName = isLvgl ? "lvw_init" : "module_init";
        const status = environment.#enter(() => (live.instance!.exports[initName] as () => number)());
        if (status !== 0) {
          rollback(new Error(`${JSON.stringify(id)}: ${initName} returned ${status}`));
        }
        live.initialized = true;
        environment.#initialized.push(live);
      }
      environment.#state = "ready";
      return environment;
    } catch (error) {
      const cleanup = environment.#releaseHosts();
      environment.#invalidateModules();
      if (cleanup.length) throw new AggregateError([error, ...cleanup], "numeric environment cleanup failed");
      throw error;
    }
  }
}

/** @internal Create a numeric environment from already compiled private snapshots. */
export function instantiateNumericEnvironment(prepared: PreparedModuleGraph, profile: NumericProfile, compiled: ReadonlyMap<string, WebAssembly.Module>, beforeGuest: () => void): NumericEnvironment {
  const runtime = NumericRuntime.load(prepared, profile, compiled, beforeGuest);
  const base = { get state() { return runtime.state; }, run: (value: number) => runtime.run(value), close: () => runtime.close() };
  return Object.freeze(profile.label ? { ...base, get state() { return runtime.state; }, readFrame: () => runtime.readFrame() } : base);
}
