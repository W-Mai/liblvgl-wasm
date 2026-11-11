import type { NumericEnvironmentOptions, NumericEventConsumerPreflightReport } from "liblvgl-wasm/feature-validator";
import { chainFixture } from "./chain.js";

export async function exerciseEventConsumer(data: ArrayBuffer, validator: Pick<typeof import("liblvgl-wasm/feature-validator"),
  "loadNumericEnvironment" | "preflightLvglEventGraphForConsumer">) {
  const { input, options: base } = chainFixture(new Uint8Array(data));
  const cases = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as {
    name: string; label: NumericEnvironmentOptions["label"]; event: NumericEnvironmentOptions["event"];
  }[];
  const item = cases.find((value) => value.name === "real");
  if (!item?.label || item.label.consumer !== "middle" || !item.event) throw new Error("invalid event consumer fixture");
  let calls = 0;
  const options: NumericEnvironmentOptions = { ...base, profile: "lvgl-event-v1", label: item.label, event: item.event,
    hosts: base.hosts.map((host) => ({ ...host, create: () => { calls++; throw new Error("unexpected host creation"); } })),
    wasi: { ...base.wasi!, onWrite: () => { calls++; throw new Error("unexpected WASI output"); } } };
  const report: NumericEventConsumerPreflightReport = await validator.preflightLvglEventGraphForConsumer(input, options);
  if (report.consumer !== "middle" || JSON.stringify(report.graph.order) !== '["lvcore","middle","app"]') {
    throw new Error("event consumer order differs");
  }
  for (const module of report.graph.modules) {
    const source = input.modules.find(({ manifest }) => manifest.id === module.id);
    const c = module.checks;
    if (!source || source.manifest.artifact.sha256 !== module.sha256 || c.identity !== "passed"
        || c.interface !== "passed" || c.feature !== "passed" || c.engine !== "passed"
        || c.resourceTopology !== "passed" || c.wasiAbi !== (module.id === "lvcore" ? "passed" : "not-observed")
        || c.hostImplementation !== "not-run" || c.lifecycle !== "not-run" || c.runtime !== "not-run"
        || c.pointerContracts !== "not-run" || c.handleIsolation !== "not-run" || c.environmentIsolation !== "not-run") {
      throw new Error("event consumer identity or checks differ");
    }
  }
  if (calls !== 0) throw new Error("preflight executed a host");
  return { consumer: report.consumer, order: report.graph.order, modules: report.graph.modules.length,
    runtime: report.graph.modules.map(({ checks }) => checks.runtime), hostCalls: calls };
}

export async function exerciseEventLibrary(data: ArrayBuffer, load: typeof import("liblvgl-wasm/feature-validator").loadNumericEnvironment) {
  const { input, options: base, traces } = chainFixture(new Uint8Array(data));
  const item = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)).find((value: { name: string }) => value.name === "real");
  if (!item?.label || item.label.consumer !== "middle" || !item.event) throw new Error("invalid event library fixture");
  const options: NumericEnvironmentOptions = { ...base, profile: "lvgl-event-v1", label: item.label, event: item.event };
  type Environment = Awaited<ReturnType<typeof load>>;
  const frame = (environment: Environment) => {
    const value = environment.readFrame?.();
    if (!value || value.width !== 120 || value.height !== 48 || value.rgba.length !== 120 * 48 * 4
        || value.rgba.some((byte, index) => index % 4 === 3 && byte !== 255)) throw new Error("invalid event library frame");
    return value.rgba;
  };
  const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.every((value, index) => value === b[index]);
  const first = await load(input, options);
  let second: Environment | undefined;
  try {
    second = await load(input, options);
    const initial = frame(first), other = frame(second);
    if (!equal(initial, other) || first.run(1) !== 2 || first.run(4) !== 1
        || JSON.stringify([5, 6, 7, 8].map((op) => first.run(op))) !== "[11,12,22,21]") throw new Error("middle callback nesting differs");
    const changed = frame(first);
    const framesDiffer = !equal(initial, changed), otherUnchanged = equal(frame(second), other);
    if (first.run(2) !== 1 || first.run(1) !== 2 || first.run(3) !== 1 || first.run(1) !== 3
        || second.run(9) !== 2 || second.run(1) !== 2 || second.run(3) !== 1 || second.run(1) !== 3) {
      throw new Error("middle callback cancellation differs");
    }
    first.run(10); first.run(11);
    const retained = changed.slice();
    first.close();
    const survivesClose = equal(changed, retained) && second.run(1) === 4 && equal(frame(second), changed);
    second.close();
    const events = [...traces.values()];
    if (!framesDiffer || !otherUnchanged || !survivesClose || events.length !== 2
        || events.some((trace) => JSON.stringify(trace) !== "[10,20,21,11]")) throw new Error("event library isolation or close differs");
    return { framesDiffer, otherUnchanged, survivesClose, traces: events, states: [first.state, second.state] };
  } finally {
    if (first.state === "ready") first.close();
    if (second?.state === "ready") second.close();
  }
}
