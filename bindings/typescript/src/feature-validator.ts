import { FEATURE_MASKS, HELPER_SHA256, POLICY_VERSION } from "../../../target/validator/generated/helper-data.ts";
import { FEATURE_WORKER_SOURCE } from "../../../target/validator/generated/worker-source.ts";
import { snapshotWasmBytes } from "./wasm-facts.ts";
import { compilePreparedModules, prepareModuleManifests, type ModuleManifestInput, type PreparedModuleGraph } from "./module-manifest.ts";
import { inspectIsolatedFacts, type IsolatedResourceReport } from "./isolated-resources.ts";
import { inspectWasiFacts, type WasiPreview1Report } from "./wasi-preview1.ts";
import { compileNumericModules, instantiateNumericEnvironment, prepareNumericProfile, type NumericEnvironment, type NumericEnvironmentOptions } from "./numeric-environment.ts";
export type { NumericEnvironment, NumericEnvironmentOptions } from "./numeric-environment.ts";
export { NumericWasiExit } from "./numeric-environment.ts";
export type { NumericWasiOptions, NumericWasiService } from "./numeric-environment.ts";

export type FeatureValidationErrorCode = "policy" | "invalid-input" | "input-limit" | "busy" | "aborted" | "timeout" | "worker-unavailable" | "helper-failed" | "reserve-failed" | "module-rejected";

export class FeatureValidationError extends Error {
  constructor(readonly code: FeatureValidationErrorCode, message: string) {
    super(message);
    this.name = "FeatureValidationError";
  }
}

export interface FeatureValidationOptions {
  readonly declaredFeatures: readonly string[];
  readonly allowedFeatures: readonly string[];
  readonly startupTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface FeatureValidationReport {
  readonly inputSha256: string;
  readonly helperSha256: string;
  readonly policyVersion: number;
  readonly declaredFeatures: readonly string[];
  readonly status: "passed";
  readonly checks: { readonly engine: "not-run"; readonly wasiAbi: "not-run"; readonly resourceTopology: "not-run"; readonly runtime: "not-run" };
}

export interface FeatureModuleGraphOptions {
  readonly allowedFeatures: readonly string[];
  readonly startupTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface FeatureModuleGraphReport {
  readonly order: readonly string[];
  readonly helperSha256: string;
  readonly policyVersion: number;
  readonly modules: readonly {
    readonly id: string;
    readonly sha256: string;
    readonly declaredFeatures: readonly string[];
    readonly wasi: Pick<WasiPreview1Report, "evidence" | "imports" | "entrypoints">;
    readonly isolated: Pick<IsolatedResourceReport, "memories" | "tables" | "usesWasi">;
    readonly checks: {
      readonly declaration: "passed"; readonly identity: "passed"; readonly interface: "passed";
      readonly feature: "passed"; readonly wasiAbi: "passed" | "not-observed"; readonly resourceTopology: "passed";
      readonly engine: "passed"; readonly targetProvenance: "not-run"; readonly pointerContracts: "not-run";
      readonly handleIsolation: "not-run"; readonly environmentIsolation: "not-run";
      readonly hostImplementation: "not-run"; readonly lifecycle: "not-run"; readonly runtime: "not-run";
    };
  }[];
}

export interface NumericLabelConsumerPreflightReport {
  readonly consumer: string;
  readonly graph: FeatureModuleGraphReport;
}

export interface NumericEventConsumerPreflightReport {
  readonly consumer: string;
  readonly graph: FeatureModuleGraphReport;
}

export class FeatureModuleGraphError extends Error {
  constructor(readonly moduleId: string, readonly stage: "feature" | "wasi" | "resource", cause: unknown) {
    super(`${JSON.stringify(moduleId)}: ${stage} inspection failed: ${String(cause)}`, { cause });
    this.name = "FeatureModuleGraphError";
  }
}

const MAX_WORKERS = 2;
let activeWorkers = 0;
let activeGraphs = 0;
/** Optional names accepted by the feature policy validator. This list does not describe engine support. */
export const WASM_FEATURE_POLICY_NAMES: readonly string[] = Object.freeze(Object.keys(FEATURE_MASKS));
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;

function featureMask(names: readonly string[], label: string): number {
  if (!Array.isArray(names) || names.length > WASM_FEATURE_POLICY_NAMES.length) {
    throw new FeatureValidationError("policy", `invalid ${label} feature list`);
  }
  let mask = 0;
  for (const name of names) {
    if (typeof name !== "string") throw new FeatureValidationError("policy", `invalid ${label} feature name`);
    if (!Object.hasOwn(FEATURE_MASKS, name)) throw new FeatureValidationError("policy", `unknown ${label} feature: ${JSON.stringify(name)}`);
    const bit = FEATURE_MASKS[name]!;
    if ((mask & bit) !== 0) throw new FeatureValidationError("policy", `duplicate ${label} feature: ${JSON.stringify(name)}`);
    mask = (mask | bit) >>> 0;
  }
  return mask;
}

function deadline(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0x7fff_ffff) {
    throw new FeatureValidationError("policy", `invalid ${label} deadline`);
  }
  return value;
}

function prepareFeatureChecks(prepared: PreparedModuleGraph, options: FeatureModuleGraphOptions) {
  if (!Array.isArray(options.allowedFeatures) || options.allowedFeatures.length > WASM_FEATURE_POLICY_NAMES.length) {
    throw new FeatureValidationError("policy", "invalid feature list");
  }
  const allowedFeatures = Object.freeze([...options.allowedFeatures]);
  const allowed = featureMask(allowedFeatures, "host");
  const startupTimeoutMs = deadline(options.startupTimeoutMs, "startup");
  const executionTimeoutMs = deadline(options.executionTimeoutMs, "execution");
  const signal = options.signal;
  if (signal !== undefined) {
    let aborted: boolean;
    try { aborted = signalAborted.call(signal) as boolean; }
    catch { throw new FeatureValidationError("invalid-input", "invalid abort signal"); }
    if (aborted) throw new FeatureValidationError("aborted", "feature validation aborted");
  }
  const records = prepared.modules.map((record) => {
    const id = record.manifest.id;
    let isolated: Pick<IsolatedResourceReport, "memories" | "tables" | "usesWasi">;
    let wasi: Pick<WasiPreview1Report, "evidence" | "imports" | "entrypoints">;
    try { isolated = inspectIsolatedFacts(record.facts); }
    catch (error) { throw new FeatureModuleGraphError(id, "resource", error); }
    try { wasi = inspectWasiFacts(record.facts); }
    catch (error) { throw new FeatureModuleGraphError(id, "wasi", error); }
    try {
      const declared = featureMask(record.manifest.target.features, "declared");
      if ((declared & ~allowed) !== 0) throw new FeatureValidationError("policy", "declared feature is not allowed by the host");
    } catch (error) { throw new FeatureModuleGraphError(id, "feature", error); }
    return { record, isolated, wasi };
  });
  return { records, options: { allowedFeatures, startupTimeoutMs, executionTimeoutMs, signal } };
}

async function verifyFeatureChecks(checks: ReturnType<typeof prepareFeatureChecks>): Promise<void> {
  const { records, options: { allowedFeatures, startupTimeoutMs, executionTimeoutMs, signal } } = checks;
  for (const { record } of records) {
    try {
      const feature = await validateWasmFeatures(record.bytes, { declaredFeatures: record.manifest.target.features,
        allowedFeatures, startupTimeoutMs, executionTimeoutMs, signal });
      if (feature.inputSha256 !== record.facts.sha256) throw new Error("feature validation snapshot identity mismatch");
    } catch (error) { throw new FeatureModuleGraphError(record.manifest.id, "feature", error); }
  }
  if (signal && signalAborted.call(signal)) throw new FeatureValidationError("aborted", "feature validation aborted");
}

function featureGraphReport(prepared: PreparedModuleGraph, checks: ReturnType<typeof prepareFeatureChecks>): FeatureModuleGraphReport {
  return { order: prepared.order, helperSha256: HELPER_SHA256, policyVersion: POLICY_VERSION,
    modules: checks.records.map(({ record, isolated, wasi }) => ({ id: record.manifest.id, sha256: record.facts.sha256,
      declaredFeatures: record.manifest.target.features, wasi, isolated, checks: {
        declaration: "passed", identity: "passed", interface: "passed", feature: "passed",
        wasiAbi: wasi.evidence === "present" ? "passed" : "not-observed", resourceTopology: "passed", engine: "passed",
        targetProvenance: "not-run", pointerContracts: "not-run", handleIsolation: "not-run", environmentIsolation: "not-run",
        hostImplementation: "not-run", lifecycle: "not-run", runtime: "not-run",
      } })) };
}

/** Inspect a module graph without instantiating it. The report is not an authorization to load the graph. */
export async function inspectFeatureModuleGraph(input: ModuleManifestInput, options: FeatureModuleGraphOptions): Promise<FeatureModuleGraphReport> {
  if (activeGraphs >= MAX_WORKERS) throw new FeatureValidationError("busy", "module graph inspection concurrency limit reached");
  activeGraphs++;
  try {
    const prepared = prepareModuleManifests(input);
    const checks = prepareFeatureChecks(prepared, options);
    await verifyFeatureChecks(checks);
    compilePreparedModules(prepared);
    return featureGraphReport(prepared, checks);
  } finally {
    activeGraphs--;
  }
}

/** Validate a trusted label consumer without creating an environment. The report does not authorize loading. */
export async function preflightLvglLabelGraphForConsumer(input: ModuleManifestInput, options: NumericEnvironmentOptions): Promise<NumericLabelConsumerPreflightReport> {
  if (activeGraphs >= MAX_WORKERS) throw new FeatureValidationError("busy", "module graph inspection concurrency limit reached");
  activeGraphs++;
  try {
    const prepared = prepareModuleManifests(input);
    const profile = prepareNumericProfile(prepared, options);
    if (!profile.label || profile.event || profile.labelConsumer === undefined) throw new Error("label consumer preflight requires lvgl-label-v1");
    const checks = prepareFeatureChecks(prepared, profile.featureOptions);
    await verifyFeatureChecks(checks);
    compileNumericModules(prepared);
    return { consumer: profile.labelConsumer, graph: featureGraphReport(prepared, checks) };
  } finally {
    activeGraphs--;
  }
}

/** Validate a trusted event consumer without creating an environment. The report does not authorize loading. */
export async function preflightLvglEventGraphForConsumer(input: ModuleManifestInput, options: NumericEnvironmentOptions): Promise<NumericEventConsumerPreflightReport> {
  if (activeGraphs >= MAX_WORKERS) throw new FeatureValidationError("busy", "module graph inspection concurrency limit reached");
  activeGraphs++;
  try {
    const prepared = prepareModuleManifests(input);
    const profile = prepareNumericProfile(prepared, options, true);
    if (!profile.label || !profile.event || profile.labelConsumer === undefined) throw new Error("event consumer preflight requires lvgl-event-v1");
    const checks = prepareFeatureChecks(prepared, profile.featureOptions);
    await verifyFeatureChecks(checks);
    compileNumericModules(prepared);
    return { consumer: profile.labelConsumer, graph: featureGraphReport(prepared, checks) };
  } finally {
    activeGraphs--;
  }
}

/** Load a trusted numeric-only graph. The returned environment does not expose Wasm resources. */
export async function loadNumericEnvironment(input: ModuleManifestInput, options: NumericEnvironmentOptions): Promise<NumericEnvironment> {
  if (activeGraphs >= MAX_WORKERS) throw new FeatureValidationError("busy", "module graph inspection concurrency limit reached");
  activeGraphs++;
  try {
    const prepared = prepareModuleManifests(input);
    const profile = prepareNumericProfile(prepared, options);
    const checks = prepareFeatureChecks(prepared, profile.featureOptions);
    await verifyFeatureChecks(checks);
    const compiled = compileNumericModules(prepared);
    const beforeGuest = () => {
      if (profile.featureOptions.signal && signalAborted.call(profile.featureOptions.signal)) throw new FeatureValidationError("aborted", "feature validation aborted");
    };
    beforeGuest();
    return instantiateNumericEnvironment(prepared, profile, compiled, beforeGuest);
  } finally {
    activeGraphs--;
  }
}

/** Validate an owned copy of the input against an explicit feature upper bound. This report does not authorize module loading. */
export async function validateWasmFeatures(input: BufferSource, options: FeatureValidationOptions): Promise<FeatureValidationReport> {
  if (!Array.isArray(options.allowedFeatures) || !Array.isArray(options.declaredFeatures)
      || options.allowedFeatures.length > WASM_FEATURE_POLICY_NAMES.length
      || options.declaredFeatures.length > WASM_FEATURE_POLICY_NAMES.length) {
    throw new FeatureValidationError("policy", "invalid feature list");
  }
  const declaredFeatures = Object.freeze([...options.declaredFeatures]);
  const allowedFeatures = [...options.allowedFeatures];
  const allowed = featureMask(allowedFeatures, "host");
  const declared = featureMask(declaredFeatures, "declared");
  if ((declared & ~allowed) !== 0) throw new FeatureValidationError("policy", "declared feature is not allowed by the host");
  const startupMs = deadline(options.startupTimeoutMs, "startup");
  const executionMs = deadline(options.executionTimeoutMs, "execution");
  const signal = options.signal;
  let aborted = false;
  if (signal !== undefined) {
    try { aborted = signalAborted.call(signal) as boolean; }
    catch { throw new FeatureValidationError("invalid-input", "invalid abort signal"); }
  }
  if (aborted) throw new FeatureValidationError("aborted", "feature validation aborted");
  if (activeWorkers >= MAX_WORKERS) throw new FeatureValidationError("busy", "feature validator concurrency limit reached");
  activeWorkers++;
  let snapshot: Uint8Array<ArrayBuffer>;
  try {
    snapshot = snapshotWasmBytes(input);
  } catch (error) {
    activeWorkers--;
    const code = error instanceof Error && error.message === "Wasm facts inspection limit: input bytes" ? "input-limit" : "invalid-input";
    throw new FeatureValidationError(code, "invalid or oversized Wasm input");
  }
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let ready = false;
    let deadlineAt = 0;
    const abort = () => finish(new FeatureValidationError("aborted", "feature validation aborted"));
    const finish = (error?: FeatureValidationError, inputSha256?: string) => {
      if (settled) return;
      settled = true;
      try { if (timer !== undefined) clearTimeout(timer); } catch { /* Continue releasing resources. */ }
      try { if (signal) removeListener.call(signal, "abort", abort); } catch { /* Continue releasing resources. */ }
      try { if (worker) worker.onmessage = null; } catch { /* Continue releasing resources. */ }
      try { if (worker) worker.onerror = null; } catch { /* Continue releasing resources. */ }
      try { if (worker) worker.onmessageerror = null; } catch { /* Continue releasing resources. */ }
      try { worker?.terminate(); } catch { /* Cleanup continues after a host error. */ }
      try { if (url !== undefined) URL.revokeObjectURL(url); } catch { /* Cleanup continues after a host error. */ }
      snapshot = new Uint8Array(0);
      activeWorkers--;
      if (error) reject(error);
      else resolve({ inputSha256: inputSha256!, helperSha256: HELPER_SHA256, policyVersion: POLICY_VERSION, declaredFeatures, status: "passed", checks: { engine: "not-run", wasiAbi: "not-run", resourceTopology: "not-run", runtime: "not-run" } });
    };
    const timeout = () => finish(new FeatureValidationError("timeout", ready ? "feature validation timed out" : "feature validator startup timed out"));
    try {
      if (typeof Worker !== "function" || typeof URL.createObjectURL !== "function") {
        throw new Error("Worker unavailable");
      }
      if (signal) addListener.call(signal, "abort", abort, { once: true });
      if (settled) return;
      if (signal && signalAborted.call(signal)) return abort();
      deadlineAt = performance.now() + startupMs;
      timer = setTimeout(timeout, startupMs);
      url = URL.createObjectURL(new Blob([FEATURE_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onerror = (event) => {
        try { event.preventDefault(); } finally { finish(new FeatureValidationError("helper-failed", "feature worker failed")); }
      };
      worker.onmessageerror = () => finish(new FeatureValidationError("helper-failed", "invalid feature worker message"));
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (settled) return;
        if (performance.now() >= deadlineAt) return timeout();
        const message = event.data as { type?: unknown; code?: unknown; accepted?: unknown; inputSha256?: unknown } | null;
        if (message?.type === "failure") {
          const code = message.code === "reserve-failed" ? "reserve-failed" : "helper-failed";
          return finish(new FeatureValidationError(code, "feature helper failed"));
        }
        if (!ready && message?.type === "ready") {
          ready = true;
          clearTimeout(timer);
          deadlineAt = performance.now() + executionMs;
          timer = setTimeout(timeout, executionMs);
          try {
            const copy = snapshot.slice();
            if (performance.now() >= deadlineAt) return timeout();
            worker!.postMessage({ bytes: copy.buffer, mask: declared, declaredFeatures, allowedFeatures }, [copy.buffer]);
          } catch {
            finish(new FeatureValidationError("helper-failed", "feature worker request failed"));
          }
          return;
        }
        if (ready && message?.type === "result" && typeof message.accepted === "boolean"
            && typeof message.inputSha256 === "string" && /^[0-9a-f]{64}$/.test(message.inputSha256)) {
          if (!message.accepted) return finish(new FeatureValidationError("module-rejected", "Wasm module is invalid under the declared feature policy"));
          return finish(undefined, message.inputSha256);
        }
        finish(new FeatureValidationError("helper-failed", "invalid feature worker response"));
      };
    } catch {
      finish(new FeatureValidationError("worker-unavailable", "feature worker could not be created"));
    }
  });
}
