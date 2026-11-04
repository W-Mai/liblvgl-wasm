import { loadNumericEnvironment, preflightLvglLabelGraphForConsumer,
  type NumericEnvironmentOptions, type NumericLabelConsumerPreflightReport } from "liblvgl-wasm/feature-validator";
import { chainFixture } from "./chain.js";

export async function exerciseLabelConsumer(data: ArrayBuffer) {
  const { input, options: base, traces } = chainFixture(new Uint8Array(data));
  const cases = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as { name: string; label: NumericEnvironmentOptions["label"] }[];
  const label = cases.find((item) => item.name === "real")?.label;
  if (!label || label.consumer !== "middle") throw new Error("invalid label consumer fixture");
  let calls = 0;
  const options: NumericEnvironmentOptions = { ...base, profile: "lvgl-label-v1", label,
    hosts: base.hosts.map((host) => ({ ...host, create: () => { calls++; throw new Error("unexpected host creation"); } })),
    wasi: { ...base.wasi!, onWrite: () => { calls++; throw new Error("unexpected WASI output"); } } };
  const expected = input.modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256 }));
  const report: NumericLabelConsumerPreflightReport = await preflightLvglLabelGraphForConsumer(input, options);
  if (report.consumer !== "middle" || JSON.stringify(report.graph.order) !== '["lvcore","middle","app"]'
      || JSON.stringify(report.graph.modules.map(({ id, sha256 }) => ({ id, sha256 }))) !== JSON.stringify(expected)) {
    throw new Error("label consumer graph report differs");
  }
  for (const module of report.graph.modules) {
    const checks = module.checks;
    if (checks.declaration !== "passed" || checks.identity !== "passed" || checks.interface !== "passed"
        || checks.feature !== "passed" || checks.wasiAbi !== (module.id === "lvcore" ? "passed" : "not-observed")
        || checks.resourceTopology !== "passed" || checks.engine !== "passed"
        || checks.targetProvenance !== "not-run" || checks.pointerContracts !== "not-run" || checks.handleIsolation !== "not-run"
        || checks.environmentIsolation !== "not-run" || checks.hostImplementation !== "not-run" || checks.lifecycle !== "not-run"
        || checks.runtime !== "not-run") throw new Error("label consumer checks differ");
  }
  if (calls !== 0) throw new Error("label preflight invoked a host");
  const runtimeOptions: NumericEnvironmentOptions = { ...base, profile: "lvgl-label-v1", label };
  const first = await loadNumericEnvironment(input, runtimeOptions);
  let second: Awaited<ReturnType<typeof loadNumericEnvironment>> | undefined;
  try {
    second = await loadNumericEnvironment(input, runtimeOptions);
    if (!first.readFrame || !second.readFrame) throw new Error("missing label frame operation");
    const readFrame = (environment: typeof first) => {
      const value = environment.readFrame!();
      if (value.width !== 120 || value.height !== 48 || value.rgba.length !== 120 * 48 * 4
          || !value.rgba.every((byte, index) => index % 4 !== 3 || byte === 255)) throw new Error("invalid label frame");
      return value;
    };
    const initial = readFrame(first), other = readFrame(second);
    if (!initial.rgba.every((value, index) => value === other.rgba[index])) throw new Error("unexpected initial label frames");
    if (first.run(1) !== 1) throw new Error("middle label update failed");
    const changed = readFrame(first), otherAfter = readFrame(second);
    const framesDiffer = initial.rgba.some((value, index) => value !== changed.rgba[index]);
    const otherUnchanged = other.rgba.every((value, index) => value === otherAfter.rgba[index]);
    if (second.run(1) !== 1 || !readFrame(second).rgba.every((value, index) => value === changed.rgba[index])) {
      throw new Error("second middle label update differs");
    }
    const retained = changed.rgba.slice();
    first.close();
    const survivesClose = changed.rgba.every((value, index) => value === retained[index]);
    if (second.run(2) !== 2 || !readFrame(second).rgba.every((value, index) => value === initial.rgba[index])) {
      throw new Error("second label environment did not survive close");
    }
    second.close();
    const events = [...traces.values()];
    if (!framesDiffer || !otherUnchanged || !survivesClose || events.length !== 2
        || events.some((trace) => JSON.stringify(trace) !== "[10,20,21,11]")) {
      throw new Error(`unexpected label library behavior: ${JSON.stringify({ framesDiffer, otherUnchanged, events })}`);
    }
    return { consumer: report.consumer, order: report.graph.order, modules: report.graph.modules.length,
      runtime: report.graph.modules.map(({ checks }) => checks.runtime), framesDiffer, otherUnchanged, survivesClose,
      traces: events, states: [first.state, second.state], hostCalls: calls };
  } finally {
    if (first.state === "ready") first.close();
    if (second?.state === "ready") second.close();
  }
}
