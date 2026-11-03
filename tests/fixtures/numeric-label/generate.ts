import { link, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  core: { type: "string" }, app: { type: "string" }, "fail-app": { type: "string" }, api: { type: "string" },
  proof: { type: "string" }, synthetic: { type: "string" }, extra: { type: "string" }, output: { type: "string" },
  "real-only": { type: "boolean", default: false }, event: { type: "boolean", default: false },
} });
const core = values.core ?? "target/wasm/liblvgl-bounded.wasm";
const app = values.app ?? `target/validator/lvgl-${values.event ? "event" : "label"}-app.wasm`;
const failApp = values["fail-app"] ?? `target/validator/lvgl-${values.event ? "event" : "label"}-app-fail-init.wasm`;
const api = values.api ?? "target/wasm/api.json";
const proof = values.proof ?? "target/wasm/api-verification-bounded.json";
const synthetic = values.synthetic ?? `target/validator/lvgl-${values.event ? "event" : "label"}-negative`;
const extra = values.extra ?? (values.event ? synthetic : "target/validator/numeric-label");
const output = resolve(values.output ?? `target/validator/numeric-${values.event ? "event" : "label"}.json`);
const maxGraphBytes = 256 * 1024 * 1024;
const inputs = [core, app, failApp, api, proof];
const physical = async (path: string) => { try { return await realpath(path); } catch (error: any) {
  if (error.code === "ENOENT") return join(await realpath(dirname(resolve(path))), basename(path));
  throw error;
} };
const outputPath = await physical(output);
if ((await Promise.all(inputs.map(physical))).includes(outputPath)) throw new Error("label graph output overlaps an input");
if (!values["real-only"]) {
  for (const directory of await Promise.all([synthetic, extra].map(physical))) {
    const path = relative(directory, outputPath);
    if (!path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) throw new Error("label graph output overlaps a fixture directory");
  }
}
try { await lstat(output); throw new Error("label graph output already exists"); }
catch (error: any) { if (error.code !== "ENOENT") throw error; }
const directory = await mkdtemp(join(dirname(output), ".numeric-label-"));
const labels = { id: "host.label", interface: { name: "lvgl", version: 1 }, width: 120, height: 48, maxLabels: 8, maxTextBytes: 4096 };
const events = { maxRegistrations: 8, maxDepth: 8 };
const features = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
const cases: any[] = [];

async function readWasm(path: string): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (file.size > 64 * 1024 * 1024) throw new Error("label fixture Wasm exceeds limit");
  const bytes = await file.bytes();
  if (bytes.length > 64 * 1024 * 1024) throw new Error("label fixture Wasm exceeds limit");
  return bytes;
}
function descriptor(facts: ReturnType<typeof inspectWasmFacts>, item: any) {
  return item.kind === "function" || item.kind === "tag" ? { kind: item.kind, ...facts.types[item.typeIndex] }
    : { kind: item.kind, ...item.type };
}

try {
  const intermediate = join(directory, "core-graph.json");
  const generated = Bun.spawnSync([process.execPath, "tests/fixtures/numeric-lvgl/generate.ts", "--real-only",
    "--core", core, "--app", app, "--api", api, "--proof", proof, "--output", intermediate]);
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  const [real] = JSON.parse(await readFile(intermediate, "utf8"));
  real.name = "real";
  real.label = labels;
  if (values.event) real.event = events;
  real.pass = true;
  real.input.modules.find((item: any) => item.manifest.id === "app").manifest.target.features = [values.event ? "reference-types" : "bulk-memory"];
  const appManifest = real.input.modules.find((item: any) => item.manifest.id === "app").manifest;
  const labelRequirement = appManifest.requires.find((requirement: any) => requirement.provider === "lvgl");
  if (!labelRequirement) throw new Error("real app has no LVGL imports");
  labelRequirement.provider = "host.label";
  appManifest.requires.push({ provider: "lvcore", interface: "lvcore", version: 1, imports: [] });
  const labelExports = labelRequirement.imports.map(({ module: _, provider_export: _provider, ...item }: any) => item);
  const labelNames = ["lv_label_create", "lv_label_set_text", "lv_screen_active", ...(values.event
    ? ["lv_obj_add_event_cb", "lv_obj_remove_event_dsc", "lv_obj_send_event", "lv_event_get_code", "lv_event_get_user_data", "lv_event_get_target_obj"] : [])].sort();
  if (labelExports.length !== labelNames.length || labelExports.map((item: any) => item.name).sort().join(",") !== labelNames.join(",")) {
    throw new Error("unexpected real LVGL label imports");
  }
  real.input.hosts.push({ id: labels.id, interface: labels.interface, exports: labelExports });
  real.profile.modules.find((item: any) => item.id === "lvcore").exports = [];
  real.allowedFeatures = features;
  cases.push(real);
  if (!values["real-only"]) {
    const failure = structuredClone(real), bytes = await readWasm(failApp), facts = inspectWasmFacts(bytes);
    failure.name = "real-fail-init-not-run";
    const module = failure.input.modules.find((item: any) => item.manifest.id === "app");
    module.hex = Buffer.from(bytes).toString("hex"); module.manifest.artifact.sha256 = facts.sha256;
    failure.profile.modules.find((item: any) => item.id === "app").sha256 = facts.sha256;
    cases.push(failure);
    const undeclared = structuredClone(real);
    undeclared.name = "real-undeclared-feature"; undeclared.pass = false; undeclared.error = "feature";
    undeclared.input.modules.find((item: any) => item.manifest.id === "app").manifest.target.features = [];
    cases.push(undeclared);
    const labelVariants = [
      { name: "synthetic", core: "core", app: "app", pass: true },
      { name: "reactor-trap", core: "core", app: "@app-reactor-trap", pass: true },
      { name: "init-trap", core: "core", app: "@app-init-trap", pass: true },
      { name: "limits-maximum", core: "core", app: "app", pass: true },
      { name: "core-no-memory", core: "core-no-memory", app: "app", error: "memory" },
      { name: "app-no-memory", core: "core", app: "app-no-memory", error: "memory" },
      { name: "alias", core: "core", app: "app-alias", error: "import is not authorized" },
      { name: "signature", core: "core", app: "app-bad-signature", error: "host contract differs" },
      { name: "core-steal", core: "core-steal", app: "app", error: "reserved" },
      { name: "missing-create", core: "@core-missing-create", app: "app", error: "lv_label_create" },
      { name: "imported-alloc", core: "@core-imported-alloc", app: "app", error: "owned function" },
      { name: "bad-display", core: "@core-bad-display", app: "app", error: "lvw_display_create" },
      { name: "missing-dependency", core: "core", app: "app", error: "depend on" },
      ...["identity", "id-conflict", "zero-width", "oversized-frame", "zero-labels", "zero-text", "too-many-labels", "text-too-long", "pointer-export"].map((name) => ({ name, core: "core", app: "app", error: name })),
    ];
    const eventVariants = [
      { name: "synthetic", core: "core", app: "app", pass: true },
      { name: "growable-app-table", core: "core", app: "app-growable-table", pass: true },
      { name: "dispatch-trap-not-run", core: "core", app: "app-dispatch-trap", pass: true },
      { name: "init-fail-not-run", core: "core", app: "app-init-fail", pass: true },
      { name: "init-trap-not-run", core: "core", app: "app-init-trap", pass: true },
      { name: "reactor-trap-not-run", core: "core", app: "app-reactor-trap", pass: true },
      { name: "callback-signature-not-run", core: "core", app: "app-wrong-index", pass: true },
      { name: "callback-empty-not-run", core: "core", app: "app-empty-index", pass: true },
      { name: "event-limits-maximum", core: "core", app: "app", pass: true },
      { name: "missing-dispatch", core: "core", app: "app-no-dispatch", error: "dispatch" },
      { name: "bad-dispatch", core: "core", app: "app-bad-dispatch", error: "dispatch" },
      { name: "imported-dispatch", core: "core", app: "app-imported-dispatch", error: "owned" },
      { name: "dispatch-alias", core: "core", app: "app-dispatch-alias", error: "numeric export contract differs" },
      { name: "missing-table", core: "core", app: "app-no-table", error: "table" },
      { name: "imported-table", core: "core", app: "app-imported-table", error: "table" },
      { name: "unbounded-table", core: "core", app: "app-unbounded-table", error: "table" },
      { name: "multiple-tables", core: "core", app: "app-multiple-tables", error: "table" },
      { name: "no-event-import", core: "core-no-event", app: "app", error: "event import" },
      { name: "bad-event-import", core: "core-badsig-event", app: "app", error: "host contract" },
      { name: "bad-add-import", core: "core", app: "app-badsig-add", error: "host contract" },
      { name: "imported-clicked", core: "core-imported-clicked", app: "app", error: "owned" },
      { name: "alias", core: "core", app: "app-alias", error: "authorized" },
      { name: "core-steal", core: "core-steal", app: "app", error: "reserved" },
      ...["lvw_event_clicked", "lvw_event_current", "lvw_event_add", "lvw_event_remove", "lv_obj_send_event", "lv_event_get_target_obj"].flatMap((name) => [
        { name: `missing-${name}`, core: `core-missing-${name}`, app: "app", error: "missing" },
        { name: `badsig-${name}`, core: `core-badsig-${name}`, app: "app", error: "signature" },
      ]),
      ...["identity", "missing-dependency", "dispatch-export", "zero-registrations", "too-many-registrations", "zero-depth", "too-deep", "table-limit"].map((name) => ({ name, core: "core", app: "app", error: name })),
    ];
    const variants = values.event ? eventVariants : labelVariants;
    for (const spec of variants) {
      const modules: any[] = [], hostExports = new Map<string, any[]>();
      for (const [id, filename] of [["app", spec.app], ["lvcore", spec.core]]) {
        const path = filename.startsWith("@") ? `${extra}/${filename.slice(1)}.wasm` : `${synthetic}/${filename}.wasm`;
        const bytes = await readWasm(path), facts = inspectWasmFacts(bytes);
        const requirements = new Map<string, any>();
        for (const item of facts.imports) {
          const provider = item.module === "trace" ? "host.trace" : item.module === "lvw" ? "host.lvw" : "host.label";
          const interfaceName = provider === "host.label" ? "lvgl" : provider.slice(5);
          let requirement = requirements.get(provider);
          if (!requirement) { requirement = { provider, interface: interfaceName, version: 1, imports: [] }; requirements.set(provider, requirement); }
          const type = descriptor(facts, item);
          requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...type });
          const entries = hostExports.get(provider) ?? [];
          if (!entries.some((entry) => entry.name === item.name)) entries.push({ name: item.name, ...type });
          hostExports.set(provider, entries);
        }
        if (id === "lvcore" && !requirements.has("host.lvw")) requirements.set("host.lvw", { provider: "host.lvw", interface: "lvw", version: 1, imports: [] });
        if (id === "app" && spec.name !== "missing-dependency") requirements.set("lvcore", { provider: "lvcore", interface: "lvcore", version: 1, imports: [] });
        const manifest = { schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
          artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
          interface: { name: id, version: 1 }, memory_model: "isolated", requires: [...requirements.values()],
          exports: facts.exports.map((item) => ({ name: item.name, ...descriptor(facts, item) })), runtime_verification: "not-run" };
        modules.push({ manifest, hex: Buffer.from(bytes).toString("hex") });
      }
      if (!hostExports.has("host.lvw")) hostExports.set("host.lvw", []);
      const hosts = [...hostExports].map(([id, exports]) => ({ id, interface: { name: id === "host.label" ? "lvgl" : id.slice(5), version: 1 }, exports }));
      const profile: any = { modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256, interface: manifest.interface, exports: [] })),
        hosts: hosts.filter((item) => item.id === "host.trace").map((item) => ({ ...item, exports: item.exports.map(({ kind: _, ...fn }: any) => fn) })),
        limits: { maxMemoryPages: 2, maxTotalMemoryPages: 4, maxTableElements: values.event ? 5 : 0, maxTotalTableElements: values.event ? 5 : 0 } };
      const label = { id: "host.label", interface: { name: "lvgl", version: 1 }, width: 8, height: 8, maxLabels: 1, maxTextBytes: 4 };
      if (spec.name === "limits-maximum") { label.width = 4096; label.height = 1024; label.maxLabels = 4096; label.maxTextBytes = 1024 * 1024; }
      if (spec.name === "identity") profile.modules[1].sha256 = "0".repeat(64);
      if (spec.name === "id-conflict") label.id = "host.lvw";
      if (spec.name === "zero-width") label.width = 0;
      if (spec.name === "oversized-frame") { label.width = 4096; label.height = 1025; }
      if (spec.name === "zero-labels") label.maxLabels = 0;
      if (spec.name === "zero-text") label.maxTextBytes = 0;
      if (spec.name === "too-many-labels") label.maxLabels = 4097;
      if (spec.name === "text-too-long") label.maxTextBytes = 1024 * 1024 + 1;
      if (spec.name === "pointer-export") profile.modules[1].exports.push({ name: "lv_obj_create", params: ["i32"], results: ["i32"] });
      const event = { maxRegistrations: 1, maxDepth: 4 };
      if (spec.name === "event-limits-maximum") { event.maxRegistrations = 4096; event.maxDepth = 64; }
      if (spec.name === "zero-registrations") event.maxRegistrations = 0;
      if (spec.name === "too-many-registrations") event.maxRegistrations = 4097;
      if (spec.name === "zero-depth") event.maxDepth = 0;
      if (spec.name === "too-deep") event.maxDepth = 65;
      if (spec.name === "table-limit") { profile.limits.maxTableElements = 3; profile.limits.maxTotalTableElements = 3; }
      if (spec.name === "dispatch-export") profile.modules[0].exports.push({ name: "app_event_dispatch", params: ["i32", "i32"], results: [] });
      if (spec.name === "dispatch-alias") profile.modules[0].exports.push({ name: "dispatch_alias", params: ["i32", "i32"], results: ["i32"] });
      cases.push({ name: spec.name, pass: !!spec.pass, error: spec.error ?? "", input: { modules, hosts }, profile, label,
        ...(values.event ? { event } : {}), allowedFeatures: [], wasi: false });
    }
  }
  const staged = join(directory, "label-graph.json");
  const bytes = new TextEncoder().encode(JSON.stringify(cases));
  if (bytes.length > maxGraphBytes) throw new Error("label graph exceeds size limit");
  await Bun.write(staged, bytes);
  await link(staged, output);
} finally {
  await rm(directory, { recursive: true, force: true });
}
