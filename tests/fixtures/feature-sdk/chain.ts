import type { NumericEnvironmentOptions } from "liblvgl-wasm/feature-validator";
import type { ModuleManifestInput } from "liblvgl-wasm";

type Loader = typeof import("liblvgl-wasm/feature-validator").loadNumericEnvironment;
type Case = { name: string; input: { modules: { manifest: ModuleManifestInput["modules"][number]["manifest"]; hex: string }[];
  hosts: ModuleManifestInput["hosts"] }; profile: { modules: NumericEnvironmentOptions["modules"]; hosts: any[];
  limits: { maxMemoryPages: number; maxTotalMemoryPages: number; maxTableElements: number; maxTotalTableElements: number } };
  allowedFeatures: string[] };

export function chainFixture(data: Uint8Array, name = "real") {
  const cases = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as Case[];
  const item = cases.find((entry) => entry.name === name);
  if (!item) throw new Error(`missing chain fixture ${name}`);
  const fromHex = (hex: string) => {
    if (hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) throw new Error("invalid chain fixture bytes");
    return Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  };
  const traces = new Map<symbol, number[]>();
  const input: ModuleManifestInput = { modules: item.input.modules.map(({ manifest, hex }) => ({ manifest, bytes: fromHex(hex) })),
    hosts: item.input.hosts };
  const options: NumericEnvironmentOptions = { profile: "lvgl-core-v1",
    lvgl: { module: "lvcore", id: "host.lvw", interface: { name: "lvw", version: 1 }, abiVersion: 1 },
    modules: item.profile.modules, hosts: item.profile.hosts.map((host) => ({ ...host,
      create: (_consumer: string, id: symbol) => ({ exports: { lifecycle: (value: number) => {
        const entries = traces.get(id) ?? []; entries.push(value); traces.set(id, entries);
      } }, close: () => {} }) })),
    wasi: { id: "host.wasi", interface: { name: "wasi", version: 1 },
      allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
      outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096,
      clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: () => { throw new Error("unexpected WASI output"); } },
    allowedFeatures: item.allowedFeatures, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    ...item.profile.limits };
  return { input, options, traces };
}

export async function exerciseChain(data: ArrayBuffer, load: Loader) {
  const { input, options, traces } = chainFixture(new Uint8Array(data));
  const first = await load(input, options);
  let second: Awaited<ReturnType<Loader>> | undefined;
  try {
    second = await load(input, options);
    const values = [first.run(5), second.run(7), first.run(5)];
    if (JSON.stringify([first.run(-10), first.run(-11), second.run(-10), second.run(-11)]) !== "[2,2,1,1]") {
      throw new Error("LVGL chain state is not isolated");
    }
    first.close();
    values.push(second.run(7));
    second.close();
    const events = [...traces.values()];
    if (JSON.stringify(values) !== "[115,117,225,227]" || events.length !== 2
        || events.some((trace) => JSON.stringify(trace) !== "[10,20,21,11]")) {
      throw new Error(`unexpected LVGL chain behavior: ${JSON.stringify({ values, events })}`);
    }
    return { values, traces: events, states: [first.state, second.state] };
  } finally {
    if (first.state === "ready") first.close();
    if (second?.state === "ready") second.close();
  }
}
