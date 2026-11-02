type PolicyHelper = WebAssembly.Exports & {
  lvw_policy_version(): number;
  lvw_feature_count(): number;
  lvw_feature_name_length(index: number): number;
  lvw_feature_name_byte(index: number, offset: number): number;
  lvw_feature_mask(index: number): number;
};

/** @internal Compare the compiled helper's policy table with trusted generated metadata. */
export function verifyHelperPolicy(exports: WebAssembly.Exports, features: Readonly<Record<string, number>>, version: number): void {
  for (const name of ["lvw_policy_version", "lvw_feature_count", "lvw_feature_name_length", "lvw_feature_name_byte", "lvw_feature_mask"]) {
    if (typeof exports[name] !== "function") throw new Error("missing helper policy export");
  }
  const helper = exports as PolicyHelper;
  const count = helper.lvw_feature_count() >>> 0;
  if ((helper.lvw_policy_version() >>> 0) !== version || count > 32 || count !== Object.keys(features).length) {
    throw new Error("helper policy identity mismatch");
  }
  const seen = new Set<string>();
  let masks = 0;
  for (let index = 0; index < count; index++) {
    const length = helper.lvw_feature_name_length(index) >>> 0;
    if (length === 0 || length > 128) throw new Error("invalid helper feature name");
    let name = "";
    for (let offset = 0; offset < length; offset++) {
      const byte = helper.lvw_feature_name_byte(index, offset);
      if (byte < 0 || byte > 0x7f) throw new Error("invalid helper feature name");
      name += String.fromCharCode(byte);
    }
    const mask = helper.lvw_feature_mask(index) >>> 0;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || seen.has(name) || !mask || (mask & (mask - 1)) !== 0
        || (masks & mask) !== 0 || !Object.hasOwn(features, name) || features[name] !== mask) {
      throw new Error("helper policy identity mismatch");
    }
    seen.add(name);
    masks = (masks | mask) >>> 0;
  }
}
