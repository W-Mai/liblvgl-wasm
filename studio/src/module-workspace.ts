import { loadModuleProject, ModuleController, type ModuleProject } from "../modules/controller.ts";
import type { ModuleGraphInput, ModuleOutput, ModuleState } from "../modules/protocol.ts";
import type { RunnerOutput } from "./protocol.ts";
import { getLocale, t } from "./i18n.ts";

type Report = Extract<ModuleOutput, { type: "module-inspected" }>["report"];
export type WorkspaceFile = { name: string; path: string; content?: string };
type Project = { input: ModuleGraphInput; name: string; sources: WorkspaceFile[]; local: boolean };
const text = (english: string, chinese: string) => getLocale() === "en" ? english : chinese;
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const assetBase = "/target/studio/modules/";

async function readLocal(files: readonly File[]): Promise<Project> {
  const json = files.filter((file) => file.name.endsWith(".json"));
  if (json.length !== 1 || files.length > 65 || json[0].size > 4 * 1024 * 1024 ||
      files.some((file) => file.size > 32 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024)
    throw new Error(text("Choose one project JSON and its Wasm files (32 MiB per module, 128 MiB total).", "请选择一份项目 JSON 及配套 Wasm 文件（每个模块 ≤32 MiB，合计 ≤128 MiB）。"));
  const content = await json[0].text();
  const project = JSON.parse(content) as ModuleProject;
  if (project?.kind !== "studio-module-project" || project.schema_version !== 1 || !Array.isArray(project.modules) || !project.modules.length || !Array.isArray(project.hosts))
    throw new Error(text("Expected a studio-module-project v1 manifest.", "需要 studio-module-project v1 清单。"));
  const wasms = new Map(files.filter((file) => file !== json[0]).map((file) => [file.name, file]));
  if (project.modules.length !== wasms.size || files.length !== wasms.size + 1) throw new Error(text("Select exactly one Wasm file for each module.", "每个模块请选择一个对应的 Wasm 文件。"));
  const modules = await Promise.all(project.modules.map(async (entry) => {
    const name = entry?.manifest?.artifact?.path;
    const file = typeof name === "string" && !/[\\/:]/.test(name) && name.endsWith(".wasm") ? wasms.get(name) : undefined;
    if (!file) throw new Error(text("Missing local Wasm file: ", "缺少本地 Wasm 文件：") + String(name));
    wasms.delete(name);
    return { manifest: entry.manifest, bytes: new Uint8Array(await file.arrayBuffer()) };
  }));
  return { name: json[0].name, local: true, input: { modules, hosts: project.hosts }, sources: [{ name: json[0].name, path: json[0].name, content }] };
}

export function createModuleWorkspace(options: {
  dimensions(): [number, number]; active(): boolean; frame(output: Extract<RunnerOutput, { type: "frame" }>): void;
  status(state: "starting" | "running" | "stopped" | "error", label: string): void;
  log(message: string, kind?: "normal" | "success" | "error"): void; clear(): void;
  source(file: WorkspaceFile, siblings: WorkspaceFile[]): void;
}) {
  let project: Project | undefined, report: Report | undefined, state: ModuleState | undefined;
  let selected = "middle", diagnostic = "", executable = false, busy = false, acting = false, revision = 0;
  const control = new ModuleController((output) => {
    if (!options.active()) return;
    if (output.type === "frame") { options.frame(output); return; }
    if (output.type === "module-inspected") {
      report = output.report; executable = output.executable;
      render();
    } else if (output.type === "module-ready" || output.type === "module-state" || output.type === "module-closed") {
      state = output.snapshot;
      renderState();
    } else if (output.type === "error") fail(output.message);
  });

  function fail(message: string) {
    if (diagnostic !== message) options.log(message, "error");
    diagnostic = message; state = undefined; executable = false;
    options.status("error", t("status.error")); render();
  }
  function renderState() {
    const ready = state?.state === "ready" && !busy && !acting;
    get("module-default").setAttribute("aria-pressed", String(project !== undefined && !project.local));
    get("module-upload").setAttribute("aria-pressed", String(!!project?.local));
    get<HTMLButtonElement>("module-event").disabled = !ready;
    const subscription = get<HTMLInputElement>("module-subscription");
    subscription.disabled = !ready; subscription.checked = state?.subscribed ?? false;
    get("module-count").textContent = state ? String(state.count) : "—";
    get("module-nested").textContent = state?.nested.length ? state.nested.join(" → ") : "—";
    get("module-trace").textContent = state?.trace.length ? state.trace.map(({ module, code }) => `${module} · ${code === 10 || code === 20 ? "init" : "close"} (${code})`).join("\n") : "—";
    get("module-project-status").textContent = diagnostic || (busy ? t("status.loading") : !project ? "—" : `${project.local ? project.name : t("modules.example")} · ${state?.state === "ready" ? t("status.running") : state?.state === "closed" ? t("status.stopped") : report ? executable ? text("Verified", "已核验") : text("Inspect only", "仅检查") : text("Not inspected", "尚未检查")}`);
    get<HTMLButtonElement>("run-button").disabled = !!project?.local && !executable;
    get<HTMLButtonElement>("reset-button").disabled = !!project?.local && !executable;
  }
  function render() {
    if (!options.active()) return;
    renderState();
    const stack = get("module-stack"), detail = get("module-detail"), checks = get("module-checks"), sources = get("module-sources");
    stack.replaceChildren(); detail.replaceChildren(); checks.replaceChildren(); sources.replaceChildren();
    if (!project) return;
    if (report) {
      const manifests = project.input.modules.map(({ manifest }) => manifest);
      const manifest = manifests.find((item) => item.id === selected) ?? manifests[0];
      selected = manifest.id;
      for (const id of [...report.order].reverse()) {
        const item = manifests.find((candidate) => candidate.id === id);
        if (!item) continue;
        const row = document.createElement("li"), button = document.createElement("button");
        button.type = "button"; button.dataset.moduleId = id; button.setAttribute("aria-pressed", String(id === selected));
        const title = document.createElement("strong"), meta = document.createElement("small");
        title.textContent = item.artifact.path;
        const deps = item.requires.filter((requirement) => manifests.some((provider) => provider.id === requirement.provider)).map((requirement) => requirement.provider);
        meta.textContent = `${item.role} · ${item.artifact.sha256.slice(0, 8)}${deps.length ? ` → ${deps.join(", ")}` : ""}`;
        button.append(title, meta); button.addEventListener("click", () => { selected = id; render(); stack.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(); });
        row.append(button); stack.append(row);
      }
      const title = document.createElement("strong"), hash = document.createElement("code");
      title.textContent = `${manifest.interface.name} v${manifest.interface.version}`; hash.textContent = manifest.artifact.sha256; hash.title = "SHA-256";
      detail.append(title, hash);
      for (const [label, list] of [[text("Imports", "导入"), manifest.requires.flatMap((requirement) => requirement.imports.map((item) => `${item.module}.${item.name} → ${requirement.provider}.${item.provider_export}`))], [text("Exports", "导出"), manifest.exports.map((item) => `${item.name} · ${item.kind}`)]] as const) {
        const disclosure = document.createElement("details"), summary = document.createElement("summary"), body = document.createElement("pre");
        summary.textContent = `${label} (${list.length})`; disclosure.append(summary, body);
        disclosure.addEventListener("toggle", () => { if (disclosure.open && !body.textContent) body.textContent = list.join("\n") || "—"; }); detail.append(disclosure);
      }
      const facts = report.modules.find((item) => item.id === selected);
      for (const [name, result] of Object.entries(facts?.checks ?? {})) {
        const row = document.createElement("div"), key = document.createElement("span"), value = document.createElement("code");
        key.textContent = name; value.textContent = result; row.dataset.result = result; row.append(key, value); checks.append(row);
      }
    } else {
      for (const { manifest } of project.input.modules) {
        const row = document.createElement("li"); row.textContent = manifest.artifact.path; stack.append(row);
      }
      const row = document.createElement("div"), key = document.createElement("span"), result = document.createElement("code");
      key.textContent = t("modules.preflight"); row.dataset.result = result.textContent = diagnostic ? "failed" : "not-run"; row.append(key, result); checks.append(row);
    }
    for (const file of project.sources) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = file.name; button.addEventListener("click", () => options.source(file, project!.sources)); sources.append(button);
    }
  }
  async function builtIn(): Promise<Project> {
    const { input } = await loadModuleProject();
    return { name: t("modules.example"), local: false, input, sources: ["source/events.c", "source/app.c", "source/build.sh", "project.json"].map((path) => ({ name: path.split("/").at(-1)!, path: assetBase + path })) };
  }
  async function start(replace?: () => Promise<Project>, inspect = false) {
    const ticket = ++revision; busy = true; acting = false; diagnostic = "";
    try {
      await control.close(); if (ticket !== revision || !options.active()) return;
      if (replace) project = undefined;
      report = undefined; state = undefined; executable = false;
      options.clear(); render(); options.status("starting", t("status.loading"));
      const next = replace ? await replace() : project ?? await builtIn();
      if (ticket !== revision || !options.active()) return;
      project = next; await control.start(next.input, ...options.dimensions(), inspect ? "inspect" : "run");
      if (ticket !== revision || !options.active()) return;
      options.status(inspect ? "stopped" : "running", inspect ? t("modules.preflight") : t("status.running"));
    } catch (error) { if (ticket === revision && options.active()) fail(error instanceof Error ? error.message : String(error)); }
    finally { if (ticket === revision) { busy = false; render(); } }
  }
  async function stop() {
    const ticket = ++revision; busy = true; acting = false; renderState();
    try { await control.close(); if (ticket === revision && options.active()) options.status("stopped", t("status.stopped")); }
    catch (error) { if (ticket === revision && options.active()) fail(String(error)); }
    finally { if (ticket === revision) { busy = false; render(); } }
  }
  async function act(action: "event" | "subscribe" | "unsubscribe") {
    const ticket = revision; acting = true; renderState();
    try { await control.action(action); }
    catch (error) { if (ticket === revision && options.active()) fail(error instanceof Error ? error.message : String(error)); }
    finally { if (ticket === revision) { acting = false; renderState(); } }
  }
  const files = get<HTMLInputElement>("module-files");
  get("module-upload").onclick = () => files.click();
  files.onchange = () => { const selectedFiles = Array.from(files.files ?? []); files.value = ""; if (selectedFiles.length) void start(() => readLocal(selectedFiles), true); };
  get("module-default").onclick = () => { void start(builtIn); };
  get("module-event").onclick = () => { void act("event"); };
  get<HTMLInputElement>("module-subscription").onchange = (event) => { void act((event.currentTarget as HTMLInputElement).checked ? "subscribe" : "unsubscribe"); };
  return { run: () => start(undefined, !!project?.local && !executable), stop, render, activeRun: () => busy || state?.state === "ready" };
}
