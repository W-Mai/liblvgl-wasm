import { valuesIdentity } from "../../target/typescript/values.ts";
import type { LvglRuntime } from "../../bindings/typescript/src/index.ts";

export function requireSdk(runtime: LvglRuntime) {
  const { identity } = runtime;
  if (identity.sdk.status !== "matched"
      || valuesIdentity.wasm_sha256 !== identity.coreSha256
      || valuesIdentity.api_sha256 !== identity.sdk.apiSha256) {
    throw new Error("TS SDK sample requires matching core and generated values; rebuild the application with the selected SDK");
  }
  return runtime.unsafe;
}
