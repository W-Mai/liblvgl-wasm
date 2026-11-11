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
  let rejected = false;
  try { await validator.loadNumericEnvironment(input, options); }
  catch (error) { rejected = error instanceof Error && error.message.includes("LVGL event consumer must be its app"); }
  if (!rejected || calls !== 0) throw new Error("preflight authorized event library execution");
  return { consumer: report.consumer, order: report.graph.order, modules: report.graph.modules.length,
    runtime: report.graph.modules.map(({ checks }) => checks.runtime), hostCalls: calls, loaderRejected: rejected };
}
