import { FEATURE_MASKS, HELPER_SHA256, POLICY_VERSION } from "../../../target/validator/generated/helper-data.ts";
import { FEATURE_WORKER_SOURCE } from "../../../target/validator/generated/worker-source.ts";
import { snapshotWasmBytes } from "./wasm-facts.ts";

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

const MAX_WORKERS = 2;
let activeWorkers = 0;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;

function featureMask(names: readonly string[], label: string): number {
  if (!Array.isArray(names) || names.length > Object.keys(FEATURE_MASKS).length) {
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

/** Validate an owned copy of the input against an explicit feature upper bound. This report does not authorize module loading. */
export async function validateWasmFeatures(input: BufferSource, options: FeatureValidationOptions): Promise<FeatureValidationReport> {
  if (!Array.isArray(options.allowedFeatures) || !Array.isArray(options.declaredFeatures)
      || options.allowedFeatures.length > Object.keys(FEATURE_MASKS).length
      || options.declaredFeatures.length > Object.keys(FEATURE_MASKS).length) {
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
