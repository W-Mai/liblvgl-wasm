import { sha256 } from "@noble/hashes/sha2.js";
import { FEATURE_MASKS, HELPER_BASE64, HELPER_SHA256, POLICY_VERSION } from "../../../target/validator/generated/helper-data.ts";
import { verifyHelperPolicy } from "./feature-validator-policy.ts";

type Helper = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  lvw_reserve(length: number): number;
  lvw_validate(mask: number): number;
  lvw_release(): number;
};

const scope = self as DedicatedWorkerGlobalScope;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function featureMask(names: unknown): number {
  if (!Array.isArray(names) || names.length > Object.keys(FEATURE_MASKS).length) throw new Error("invalid feature list");
  let mask = 0;
  for (const name of names) {
    if (typeof name !== "string" || !Object.hasOwn(FEATURE_MASKS, name)) throw new Error("invalid feature name");
    const bit = FEATURE_MASKS[name]!;
    if ((mask & bit) !== 0) throw new Error("duplicate feature name");
    mask = (mask | bit) >>> 0;
  }
  return mask;
}

function initialize(): Helper {
  const bytes = Uint8Array.from(atob(HELPER_BASE64), (character) => character.charCodeAt(0));
  if (hex(sha256(bytes)) !== HELPER_SHA256) throw new Error("helper identity mismatch");
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error("helper has imports");
  const helper = new WebAssembly.Instance(module).exports as Helper;
  if (!(helper.memory instanceof WebAssembly.Memory) || typeof helper.lvw_reserve !== "function"
      || typeof helper.lvw_validate !== "function" || typeof helper.lvw_release !== "function") {
    throw new Error("invalid helper exports");
  }
  verifyHelperPolicy(helper, FEATURE_MASKS, POLICY_VERSION);
  return helper;
}

try {
  const helper = initialize();
  let used = false;
  scope.onmessage = (event: MessageEvent<unknown>) => {
    if (used) return;
    used = true;
    try {
      const message = event.data as { bytes?: unknown; mask?: unknown; declaredFeatures?: unknown; allowedFeatures?: unknown } | null;
      if (!message || !(message.bytes instanceof ArrayBuffer) || typeof message.mask !== "number" || !Number.isInteger(message.mask)
          || message.mask < 0 || message.mask > 0xffff_ffff) {
        throw new Error("invalid validation request");
      }
      const declared = featureMask(message.declaredFeatures), allowed = featureMask(message.allowedFeatures);
      if (declared !== message.mask || (declared & ~allowed) !== 0) throw new Error("feature policy mismatch");
      const bytes = new Uint8Array(message.bytes);
      if (bytes.length > 64 * 1024 * 1024) throw new Error("oversized validation request");
      const inputSha256 = hex(sha256(bytes));
      if (bytes.length === 0) {
        scope.postMessage({ type: "result", accepted: false, inputSha256 });
        return;
      }
      const pointer = helper.lvw_reserve(bytes.length) >>> 0;
      if (pointer === 0) {
        scope.postMessage({ type: "failure", code: "reserve-failed" });
        return;
      }
      const memory = helper.memory.buffer;
      if (pointer + bytes.length > memory.byteLength) throw new Error("invalid helper allocation");
      new Uint8Array(memory, pointer, bytes.length).set(bytes);
      const status = helper.lvw_validate(message.mask);
      if (helper.lvw_release() !== 1) throw new Error("invalid helper release");
      if (status === 0 || status === 1) {
        scope.postMessage({ type: "result", accepted: status === 0, inputSha256 });
      } else {
        throw new Error("invalid helper status");
      }
    } catch {
      scope.postMessage({ type: "failure", code: "helper-failed" });
    }
  };
  scope.postMessage({ type: "ready" });
} catch {
  scope.postMessage({ type: "failure", code: "helper-failed" });
}
