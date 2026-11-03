import { expect, test } from "bun:test";
import { prepareModuleManifests } from "../bindings/typescript/src/module-manifest.ts";
import { compileNumericModules, prepareNumericProfile } from "../bindings/typescript/src/numeric-environment.ts";
import { inspectFeatureModuleGraph } from "../target/validator/feature-validator.js";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

test("shared event graphs validate without creating hosts or executing guests", async () => {
  const path = Bun.env.LVW_TEST_EVENT_GRAPH;
  if (!path) throw new Error("LVW_TEST_EVENT_GRAPH is required");
  const cases = await Bun.file(path).json() as any[];
  expect(cases.length).toBeGreaterThan(30);
  for (const item of cases) {
    const input = { ...item.input, modules: item.input.modules.map((module: any) => ({ manifest: module.manifest,
      bytes: new Uint8Array(Buffer.from(module.hex, "hex")) })) };
    if (item.name === "dispatch-alias") {
      const facts = inspectWasmFacts(input.modules.find((module: any) => module.manifest.id === "app").bytes);
      const dispatch = facts.exports.find((item) => item.name === "app_event_dispatch");
      const alias = facts.exports.find((item) => item.name === "dispatch_alias");
      expect(dispatch?.kind).toBe("function");
      expect(alias?.kind).toBe("function");
      if (dispatch?.kind !== "function" || alias?.kind !== "function") throw new Error("missing dispatcher alias");
      expect(alias.index).toBe(dispatch.index);
    }
    let factories = 0;
    const options = { profile: "lvgl-event-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: { name: "lvw", version: 1 }, abiVersion: 1 },
      label: item.label, event: item.event, modules: item.profile.modules, hosts: item.profile.hosts.map((host: any) => ({ ...host,
        create: () => { factories++; throw new Error("preflight must not create a host"); } })),
      ...(item.wasi ? { wasi: { id: "host.wasi", interface: { name: "wasi", version: 1 },
        allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
        outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096,
        clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: () => { throw new Error("preflight must not write"); } } } : {}),
      ...item.profile.limits, allowedFeatures: item.allowedFeatures, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000 };
    const check = () => { const prepared = prepareModuleManifests(input); prepareNumericProfile(prepared, options); compileNumericModules(prepared); };
    if (item.pass || item.error === "feature") expect(check, item.name).not.toThrow();
    else {
      const expected: Record<string, string> = {
        "missing-dispatch": "missing app_event_dispatch", "bad-dispatch": "invalid app_event_dispatch signature",
        "imported-dispatch": "app_event_dispatch must be an owned function", "dispatch-alias": "numeric export contract differs", "missing-table": "requires its own table", "imported-table": "requires its own table",
        "unbounded-table": "numeric table limit exceeded", "multiple-tables": "requires its own table",
        "no-event-import": "requires the core event import", "bad-event-import": "LVGL host contract differs", "bad-add-import": "LVGL label host contract differs",
        "imported-clicked": "lvw_event_clicked must be an owned function", alias: "LVGL label import is not authorized",
        "core-steal": "LVGL label host is reserved for its app", identity: "numeric module is not authorized",
        "missing-dependency": "label app must depend on its LVGL core", "dispatch-export": "unsupported numeric function signature",
        "zero-registrations": "invalid LVGL event limits", "too-many-registrations": "invalid numeric resource limit",
        "zero-depth": "invalid LVGL event limits", "too-deep": "invalid numeric resource limit", "table-limit": "numeric table limit exceeded",
      };
      const error = item.name.startsWith("missing-lv") ? `missing ${item.name.slice(8)}` : item.name.startsWith("badsig-lv")
        ? `invalid ${item.name.slice(7)} signature` : expected[item.name];
      expect(error, item.name).toBeDefined();
      expect(check, item.name).toThrow(error!);
    }
    expect(factories, item.name).toBe(0);
    if (item.name === "real") {
      const report = await inspectFeatureModuleGraph(input, options);
      expect(report.order).toEqual(["lvcore", "app"]);
      for (const module of report.modules) {
        expect(module.checks.engine).toBe("passed");
        expect(module.checks.hostImplementation).toBe("not-run");
        expect(module.checks.lifecycle).toBe("not-run");
        expect(module.checks.runtime).toBe("not-run");
      }
    }
    if (item.error === "feature") {
      const error = await inspectFeatureModuleGraph(input, options).then(() => null, (failure) => failure);
      expect(String(error)).toContain('"app": feature inspection failed');
      expect(String(error)).toContain("invalid under the declared feature policy");
    }
  }
}, 300_000);
