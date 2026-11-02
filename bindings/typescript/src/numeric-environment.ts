import type { ModuleExport, ModuleInterface, PreparedModuleGraph } from "./module-manifest.ts";

const WasmModule = WebAssembly.Module;
const WasmInstance = WebAssembly.Instance;
const reserved = new Set(["_initialize", "_start", "module_init", "module_close", "app_run"]);

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
  readonly profile: "numeric-v1";
  readonly modules: readonly NumericModuleContract[];
  readonly hosts: readonly NumericHostContract[];
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
  readonly app: string;
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
    "maxMemoryPages", "maxTotalMemoryPages", "maxTableElements", "maxTotalTableElements"], ["signal"]);
  if (root.profile !== "numeric-v1") return fail("unsupported numeric profile");
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
  const allowedFeatures = list(root.allowedFeatures, 32).map(name);
  const featureOptions = { allowedFeatures, startupTimeoutMs: root.startupTimeoutMs as number, executionTimeoutMs: root.executionTimeoutMs as number,
    signal: root.signal as AbortSignal | undefined };
  const maxMemoryPages = limit(root.maxMemoryPages, 65536), maxTotalMemoryPages = limit(root.maxTotalMemoryPages, 65536 * 256);
  const maxTableElements = limit(root.maxTableElements, 0xffff_ffff), maxTotalTableElements = limit(root.maxTotalTableElements, 0xffff_ffff * 256);
  if (modules.size !== prepared.modules.length || hosts.size !== prepared.hosts.length) return fail("numeric profile provider inventory differs");
  let totalMemory = 0, totalTables = 0;
  let app: string | undefined;
  for (const record of prepared.modules) {
    const current = record.manifest, contract = modules.get(current.id);
    if (!contract || contract.sha256 !== record.facts.sha256 || !sameInterface(contract.interface, current.interface)) fail(`${JSON.stringify(current.id)}: numeric module is not authorized`);
    if (current.role === "app") { if (app !== undefined) fail("numeric profile requires exactly one app"); app = current.id; }
    if (record.facts.imports.some((item) => item.module === "wasi_snapshot_preview1" || item.module === "wasi_unstable" || item.module.startsWith("wasi:"))) {
      fail(`${JSON.stringify(current.id)}: WASI imports are unsupported by numeric-v1`);
    }
    if (record.facts.exports.some((item) => item.name === "_start")) fail(`${JSON.stringify(current.id)}: _start is unsupported by numeric-v1`);
    ownEntrypoint(record, "_initialize", [], [], false);
    ownEntrypoint(record, "module_init", [], ["i32"], true);
    ownEntrypoint(record, "module_close", [], ["i32"], true);
    if (current.role === "app") ownEntrypoint(record, "app_run", ["i32"], ["i32"], true);
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
  if (app === undefined) return fail("numeric profile requires exactly one app");
  if (totalMemory > maxTotalMemoryPages || totalTables > maxTotalTableElements) return fail("numeric environment resource limit exceeded");
  for (const host of prepared.hosts) {
    const contract = hosts.get(host.id);
    if (!contract || !sameInterface(contract.interface, host.interface) || contract.exports.length !== host.exports.length) fail(`${JSON.stringify(host.id)}: numeric host contract differs`);
    for (const fn of contract.exports) {
      const actual = host.exports.find((item) => item.name === fn.name);
      if (!actual || !sameFunction(fn, actual)) fail(`${JSON.stringify(host.id)}: numeric host export differs for ${JSON.stringify(fn.name)}`);
    }
  }
  for (const record of prepared.modules) for (const requirement of record.manifest.requires) for (const item of requirement.imports) {
    if (item.kind !== "function" || reserved.has(item.provider_export)) fail(`${JSON.stringify(record.manifest.id)}: unsupported numeric import`);
    const provider = modules.get(requirement.provider) ?? hosts.get(requirement.provider);
    const contract = provider?.exports.find((fn) => fn.name === item.provider_export);
    if (!contract || !sameFunction(contract, { ...item, name: item.name })) fail(`${JSON.stringify(record.manifest.id)}: numeric import is not authorized`);
  }
  return { modules, hosts, app, featureOptions };
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

/** A numeric-v1 environment with private module instances. */
export interface NumericEnvironment {
  readonly state: "loading" | "ready" | "closing" | "closed" | "poisoned";
  run(value: number): number;
  close(): void;
}

class NumericRuntime {
  #state: "loading" | "ready" | "closing" | "closed" | "poisoned" = "loading";
  #failure: unknown;
  #depth = 0;
  #modules = new Map<string, LiveModule>();
  #initialized: LiveModule[] = [];
  #hosts: LiveHost[] = [];
  #app: string;

  constructor(app: string) { this.#app = app; }
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
      const close = module.instance!.exports.module_close as () => number;
      const status = this.#enter(close);
      if (status !== 0) this.#poison(new Error(`${JSON.stringify(module.record.manifest.id)}: module_close returned ${status}`));
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
    const environment = new NumericRuntime(profile.app);
    const environmentId = Symbol("numeric environment");
    const hostBindings = new Map<string, Map<string, LiveHost>>();
    try {
      for (const record of prepared.modules) environment.#modules.set(record.manifest.id, { record, initialized: false });
      for (const id of prepared.order) {
        const record = environment.#modules.get(id)!.record;
        const byHost = new Map<string, LiveHost>();
        for (const requirement of record.manifest.requires) {
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
        const initialize = live.instance.exports._initialize;
        if (typeof initialize === "function") environment.#enter(() => initialize());
        const status = environment.#enter(() => (live.instance!.exports.module_init as () => number)());
        if (status !== 0) {
          const failure = new Error(`${JSON.stringify(id)}: module_init returned ${status}`);
          environment.#state = "closing";
          try { environment.#closeInitialized(); }
          catch (error) { throw new AggregateError([failure, error], "numeric initialization rollback failed"); }
          throw failure;
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
  return Object.freeze({ get state() { return runtime.state; }, run: (value: number) => runtime.run(value), close: () => runtime.close() });
}
