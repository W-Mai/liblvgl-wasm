import { FeatureValidationError, WASM_FEATURE_POLICY_NAMES, validateWasmFeatures } from "liblvgl-wasm/feature-validator";
import { inspectWasmFacts } from "liblvgl-wasm";

const coreFeatures = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11]);

async function rejected(promise: Promise<unknown>): Promise<string> {
  try { await promise; throw new Error("unexpected acceptance"); }
  catch (error) { if (!(error instanceof FeatureValidationError)) throw error; return error.code; }
}

export async function exercise(core: ArrayBuffer) {
  const options = { startupTimeoutMs: 10_000, executionTimeoutMs: 10_000 };
  const input = new Uint8Array(core), original = input.slice();
  const pending = validateWasmFeatures(input, { ...options, declaredFeatures: coreFeatures, allowedFeatures: coreFeatures });
  input.fill(0);
  const report = await pending;
  const coreDenied = await rejected(validateWasmFeatures(original, { ...options, declaredFeatures: [], allowedFeatures: coreFeatures }));
  const simdResult = await validateWasmFeatures(simd, { ...options, declaredFeatures: ["simd"], allowedFeatures: ["simd"] });
  const spoofed = new Uint8Array([...simd, 0, 17, 15, ...new TextEncoder().encode("target_features"), 0]);
  const simdDenied = await rejected(validateWasmFeatures(spoofed, { ...options, declaredFeatures: [], allowedFeatures: ["simd"] }));
  const policyDenied = await rejected(validateWasmFeatures(simd, { ...options, declaredFeatures: ["simd"], allowedFeatures: [] }));
  const abort = new AbortController();
  abort.abort();
  const aborted = await rejected(validateWasmFeatures(simd, { ...options, declaredFeatures: [], allowedFeatures: [], signal: abort.signal }));
  return { report, coreDenied, simdStatus: simdResult.status, simdDenied, policyDenied, aborted,
    knownFeatures: WASM_FEATURE_POLICY_NAMES.includes("simd") && Object.isFrozen(WASM_FEATURE_POLICY_NAMES),
    rootExport: inspectWasmFacts(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).imports.length === 0 };
}
