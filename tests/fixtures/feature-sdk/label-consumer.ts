import { loadNumericEnvironment, preflightLvglLabelGraphForConsumer,
  type NumericEnvironmentOptions, type NumericLabelConsumerPreflightReport } from "liblvgl-wasm/feature-validator";
import { chainFixture } from "./chain.js";

export async function exerciseLabelConsumer(data: ArrayBuffer) {
  const { input, options: base } = chainFixture(new Uint8Array(data));
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
  let rejection = "";
  try { await loadNumericEnvironment(input, options); throw new Error("label library load unexpectedly succeeded"); }
  catch (error) { rejection = String(error); }
  if (!rejection.includes("LVGL label library consumer is not supported by the loader") || calls !== 0) {
    throw new Error(`unexpected label consumer load result: ${rejection}, calls=${calls}`);
  }
  return { consumer: report.consumer, order: report.graph.order, modules: report.graph.modules.length,
    runtime: report.graph.modules.map(({ checks }) => checks.runtime), loaderRejected: true, hostCalls: calls };
}
