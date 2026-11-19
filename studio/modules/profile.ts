import type { NumericEnvironmentOptions, NumericWasiService } from "../../target/studio/modules/sdk/feature-validator.js";
import type { ModuleGraphInput, ModuleTrace } from "./protocol.ts";

export const FEATURE_POLICY = {
  allowedFeatures: ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"],
  startupTimeoutMs: 10_000, executionTimeoutMs: 10_000,
} as const;

const wasiServices: readonly NumericWasiService[] = ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"];
const labelFunctions = new Set(["lv_screen_active", "lv_label_create", "lv_label_set_text"]);

/** Resolve host implementations locally. Uploaded declarations describe requests, never host code or limits. */
export function studioProfile(input: ModuleGraphInput, width: number, height: number,
  trace: (entry: ModuleTrace) => void): NumericEnvironmentOptions {
  type Host = ModuleGraphInput["hosts"][number];
  type BusinessFunction = NumericEnvironmentOptions["modules"][number]["exports"][number];
  const providers = new Map(input.modules.map(({ manifest }) => [manifest.id, new Map<string, BusinessFunction>()]));
  const consumers = new Map<string, Set<string>>();
  for (const { manifest } of input.modules) {
    for (const edge of manifest.requires) {
      let users = consumers.get(edge.provider);
      if (!users) consumers.set(edge.provider, users = new Set());
      users.add(manifest.id);
      const functions = providers.get(edge.provider);
      if (!functions) continue;
      for (const fn of edge.imports) {
        if (fn.kind !== "function" || !fn.params.every((type): type is "i32" => type === "i32")
            || !fn.results.every((type): type is "i32" => type === "i32") || fn.results.length !== 1) {
          throw new Error(`Unsupported numeric interface: ${edge.provider}.${fn.provider_export}`);
        }
        functions.set(fn.provider_export, { name: fn.provider_export, params: fn.params, results: fn.results });
      }
    }
  }
  const owner = (host: Host) => {
    const users = consumers.get(host.id);
    if (users?.size !== 1) throw new Error(`${host.id} requires exactly one consumer`);
    return users.values().next().value!;
  };
  let lvgl: NumericEnvironmentOptions["lvgl"], label: NumericEnvironmentOptions["label"];
  let event: NumericEnvironmentOptions["event"], wasi: NumericEnvironmentOptions["wasi"];
  const hosts: NumericEnvironmentOptions["hosts"][number][] = [];
  for (const host of input.hosts) {
    const identity = { id: host.id, interface: host.interface };
    if (host.interface.version !== 1) throw new Error(`Unsupported host interface: ${host.interface.name} v${host.interface.version}`);
    switch (host.interface.name) {
      case "lvw":
        if (lvgl) throw new Error("Multiple LVGL bridge providers");
        lvgl = { ...identity, module: owner(host), abiVersion: 1 };
        break;
      case "lvgl":
        if (label) throw new Error("Multiple LVGL label providers");
        label = { ...identity, consumer: owner(host), width, height, maxLabels: 256, maxTextBytes: 4096 };
        if (host.exports.some((fn) => !labelFunctions.has(fn.name))) event = { maxRegistrations: 64, maxDepth: 8 };
        break;
      case "wasi": {
        if (wasi) throw new Error("Multiple WASI providers");
        const allowed = host.exports.map((fn) => {
          const service = wasiServices.find((name) => name === fn.name);
          if (!service) throw new Error(`Unsupported WASI service: ${fn.name}`);
          return service;
        });
        wasi = { ...identity, allowed, outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096,
          clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: () => { throw new Error("WASI output is disabled"); } };
        break;
      }
      case "trace":
        hosts.push({ ...identity, exports: [{ name: "lifecycle", params: ["i32"], results: [] }],
          create: (module) => ({ exports: { lifecycle: (code: number) => trace({ module, code }) }, close: () => {} }) });
        break;
      default: throw new Error(`Unsupported host interface: ${host.interface.name} v${host.interface.version}`);
    }
  }
  if (label && !lvgl) throw new Error("LVGL label imports require a bridge core");
  return {
    profile: event ? "lvgl-event-v1" : label ? "lvgl-label-v1" : lvgl ? "lvgl-core-v1" : "numeric-v1",
    ...(lvgl && { lvgl }), ...(label && { label }), ...(event && { event }), ...(wasi && { wasi }), hosts,
    modules: input.modules.map(({ manifest: { id, artifact, interface: iface } }) =>
      ({ id, sha256: artifact.sha256, interface: iface, exports: [...providers.get(id)!.values()] })),
    maxMemoryPages: 4096, maxTotalMemoryPages: 8192, maxTableElements: 4096, maxTotalTableElements: 8192,
    ...FEATURE_POLICY,
  };
}
