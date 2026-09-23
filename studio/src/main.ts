import { StudioController } from "./controller.ts";
import { startCDemo } from "./c-demo.ts";
import { inspectCore } from "./core.ts";
import { renderHighlighted } from "./highlight.ts";
import { readResources } from "./resources.ts";
import type { AppSource, RunnerOutput } from "./protocol.ts";

type Language = "js" | "ts" | "c" | "cpp" | "rust";
type Source = { name: string; origin: string; load(): Promise<AppSource> };

const toolchains: Record<Language, {
  name: string; output: string; summary: string; command: string;
  sample: string; kind: "js" | "wasm"; links: [string, string][];
}> = {
  js: {
    name: "JavaScript", output: "Upload .js",
    summary: "Write a single JavaScript file with a main(api) entry point. No compilation needed.",
    command: "No build step — upload toolchains/js/app.js",
    sample: "/toolchains/js/app.js", kind: "js",
    links: [["app.js", "/toolchains/js/app.js"]],
  },
  ts: {
    name: "TypeScript", output: "Build to .js",
    summary: "Write typed UI code, then bundle it into one browser-ready JavaScript file.",
    command: "bun run build:ts-app\n# upload target/apps/ts/app.js",
    sample: "/target/apps/ts/app.js", kind: "js",
    links: [["app.ts", "/toolchains/ts/app.ts"]],
  },
  c: {
    name: "C", output: "Build to .wasm",
    summary: "Call the versioned application ABI through a small C header. Compile with wasi-sdk.",
    command: "./toolchains/c/build.sh\n# upload target/apps/c/app.wasm",
    sample: "/target/apps/c/app.wasm", kind: "wasm",
    links: [["app.c", "/toolchains/c/app.c"], ["build.sh", "/toolchains/c/build.sh"], ["lvw_app.h", "/toolchains/include/lvw_app.h"]],
  },
  cpp: {
    name: "C++", output: "Build to .wasm",
    summary: "Use the same application ABI from C++ with a C linkage boundary and wasi-sdk.",
    command: "./toolchains/cpp/build.sh\n# upload target/apps/cpp/app.wasm",
    sample: "/target/apps/cpp/app.wasm", kind: "wasm",
    links: [["app.cpp", "/toolchains/cpp/app.cpp"], ["build.sh", "/toolchains/cpp/build.sh"], ["lvw_app.h", "/toolchains/include/lvw_app.h"]],
  },
  rust: {
    name: "Rust", output: "Build to .wasm",
    summary: "Build a no_std Wasm app that imports the application ABI from the browser host.",
    command: "./toolchains/rust/build.sh\n# upload target/apps/rust/app.wasm",
    sample: "/target/apps/rust/app.wasm", kind: "wasm",
    links: [["lib.rs", "/toolchains/rust/src/lib.rs"], ["Cargo.toml", "/toolchains/rust/Cargo.toml"], ["build.sh", "/toolchains/rust/build.sh"]],
  },
};

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing element: ${selector}`);
  return value;
}

const canvas = element<HTMLCanvasElement>("#screen");
const context = canvas.getContext("2d");
if (!context) throw new Error("Canvas 2D context is unavailable");
const status = element<HTMLElement>("#run-status");
const consoleOutput = element<HTMLElement>("#console-output");
const coreName = element<HTMLElement>("#core-name");
const coreOrigin = element<HTMLElement>("#core-origin");
const appName = element<HTMLElement>("#app-name");
const appOrigin = element<HTMLElement>("#app-origin");
const coreDrop = element<HTMLLabelElement>("#core-drop");
const coreFile = element<HTMLInputElement>("#core-file");
const appFile = element<HTMLInputElement>("#app-file");
const resourceFiles = element<HTMLInputElement>("#resource-files");
const resourceList = element<HTMLUListElement>("#resource-list");
const viewportSelect = element<HTMLSelectElement>("#viewport-select");
const stage = element<HTMLElement>(".stage");
const device = element<HTMLElement>(".device-wrap");

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#20201e" : "#efeeeb");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  }
  try { localStorage.setItem("lvgl-studio-theme", theme); } catch { /* Storage may be unavailable. */ }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
  button.addEventListener("click", () => setTheme(button.dataset.themeChoice as "light" | "dark"));
}
setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

let selectedCore: File | undefined;
let selectedApp: Source = {
  name: "JS sample application", origin: "SAMPLE",
  load: () => fetchApp(toolchains.js.sample, "js"),
};
let selectedLanguage: Language = "js";
let resources: File[] = [];
let width = 320;
let height = 240;
let generation = 0;
let running = false;

function fitDevice(): void {
  const stageStyle = getComputedStyle(stage);
  const deviceStyle = getComputedStyle(device);
  const screenStyle = getComputedStyle(element<HTMLElement>(".device-screen"));
  const pixels = (value: string): number => Number.parseFloat(value) || 0;
  const available = stage.clientWidth - pixels(stageStyle.paddingLeft) - pixels(stageStyle.paddingRight);
  const maxWidth = Math.min(820, available);
  const fractions = maxWidth < 500 ? [0.78, 0.89, 1] : [0.7, 0.85, 1];
  const index = width === 320 ? 0 : width === 480 ? 1 : 2;
  const shellWidth = Math.floor(maxWidth * fractions[index]);
  const frameWidth = [deviceStyle.paddingLeft, deviceStyle.paddingRight,
    deviceStyle.borderLeftWidth, deviceStyle.borderRightWidth,
    screenStyle.borderLeftWidth, screenStyle.borderRightWidth].reduce((sum, value) => sum + pixels(value), 0);
  const frameHeight = [deviceStyle.paddingTop, deviceStyle.paddingBottom,
    deviceStyle.borderTopWidth, deviceStyle.borderBottomWidth,
    screenStyle.borderTopWidth, screenStyle.borderBottomWidth].reduce((sum, value) => sum + pixels(value), 0)
    + element<HTMLElement>(".device-top").offsetHeight + element<HTMLElement>(".device-bottom").offsetHeight;
  const shellHeight = Math.round((shellWidth - frameWidth) * height / width + frameHeight);
  device.style.width = `${shellWidth}px`;
  device.style.height = `${shellHeight}px`;
  stage.style.setProperty("--shell-height", `${shellHeight}px`);
}

function appendLog(message: string, kind: "normal" | "success" | "error" = "normal"): void {
  const line = document.createElement("div");
  line.className = `log-line ${kind}`;
  const time = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const content = document.createElement("p");
  content.textContent = message;
  line.append(time, content);
  consoleOutput.append(line);
  while (consoleOutput.childElementCount > 100) consoleOutput.firstElementChild?.remove();
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function setStatus(value: "starting" | "running" | "stopped" | "error", label: string): void {
  status.dataset.state = value;
  status.textContent = label;
}

function onOutput(message: RunnerOutput): void {
  if (message.type === "ready") {
    running = true;
    setStatus("running", "Application running");
    appendLog(`Core ABI 1 ready · ${message.coreExports} exports · ${message.width} × ${message.height}`, "success");
  } else if (message.type === "frame") {
    if (canvas.width !== message.width || canvas.height !== message.height) {
      canvas.width = message.width;
      canvas.height = message.height;
    }
    context!.putImageData(new ImageData(new Uint8ClampedArray(message.pixels), message.width, message.height), 0, 0);
    element<HTMLElement>("#frame-count").textContent = `Frame ${message.frameId}`;
  } else if (message.type === "log") {
    appendLog(message.message);
  } else if (message.type === "error") {
    running = false;
    setStatus("error", "Application error");
    appendLog(message.message, "error");
  }
}

const controller = new StudioController(onOutput);

async function fetchBuffer(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.arrayBuffer();
}

async function fetchApp(path: string, kind: "js" | "wasm"): Promise<AppSource> {
  if (kind === "js") return { kind, source: new TextDecoder().decode(await fetchBuffer(path)) };
  return { kind, bytes: await fetchBuffer(path) };
}

function stop(): void {
  generation++;
  controller.stop();
  running = false;
  setStatus("stopped", "Application stopped");
}

async function run(): Promise<boolean> {
  stop();
  const runId = generation;
  setStatus("starting", "Loading application");
  appendLog(`Starting ${selectedApp.name} with ${selectedCore?.name || "default liblvgl.wasm"}…`);
  try {
    const [core, app, assets] = await Promise.all([
      selectedCore ? selectedCore.arrayBuffer() : fetchBuffer("/target/wasm/liblvgl.wasm"),
      selectedApp.load(), readResources(resources),
    ]);
    if (runId !== generation) return false;
    await controller.start({ core, app, resources: assets, width, height });
    return true;
  } catch (error) {
    if (runId !== generation) return false;
    controller.stop();
    setStatus("error", "Application failed to start");
    appendLog(error instanceof Error ? error.message : String(error), "error");
    return false;
  }
}

function showCoreSource(): void {
  const custom = !!selectedCore;
  element<HTMLButtonElement>("#core-default").classList.toggle("selected", !custom);
  element<HTMLButtonElement>("#core-custom").classList.toggle("selected", custom);
  element<HTMLButtonElement>("#core-default").setAttribute("aria-pressed", String(!custom));
  element<HTMLButtonElement>("#core-custom").setAttribute("aria-pressed", String(custom));
  coreDrop.classList.toggle("is-hidden", !custom);
  coreName.textContent = selectedCore?.name || "liblvgl.wasm";
  coreOrigin.textContent = custom ? "LOCAL FILE" : "BUILT-IN";
}

async function chooseCore(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith(".wasm") || file.size === 0 || file.size > 32 * 1024 * 1024) {
    appendLog("Choose a .wasm library between 1 byte and 32 MiB", "error");
    return;
  }
  try {
    await inspectCore(await file.arrayBuffer());
  } catch (error) {
    appendLog(`Library rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  const previous = selectedCore;
  selectedCore = file;
  showCoreSource();
  if (!await run() && selectedCore === file) {
    selectedCore = previous;
    showCoreSource();
    await run();
  }
}

async function chooseApp(file: File): Promise<void> {
  const suffix = file.name.toLowerCase();
  const kind = suffix.endsWith(".wasm") ? "wasm" : suffix.endsWith(".js") ? "js" : undefined;
  if (!kind || file.size === 0 || file.size > 8 * 1024 * 1024) {
    appendLog("Choose a built .js or .wasm application up to 8 MiB", "error");
    return;
  }
  const candidate: Source = {
    name: file.name, origin: "LOCAL FILE",
    load: async () => kind === "js" ? { kind, source: await file.text() }
      : { kind, bytes: await file.arrayBuffer() },
  };
  const previous = selectedApp;
  selectedApp = candidate;
  appName.textContent = candidate.name;
  appOrigin.textContent = candidate.origin;
  if (!await run() && selectedApp === candidate) {
    selectedApp = previous;
    appName.textContent = previous.name;
    appOrigin.textContent = previous.origin;
    await run();
  }
}

function fileDrop(target: HTMLElement, onFile: (file: File) => void): void {
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    target.classList.add("dragging");
  });
  target.addEventListener("dragleave", () => target.classList.remove("dragging"));
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    target.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (file) onFile(file);
  });
  target.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      target.click();
    }
  });
}

function renderResources(): void {
  resourceList.replaceChildren();
  if (!resources.length) {
    const item = document.createElement("li");
    item.className = "empty-resource";
    item.textContent = "No assets added";
    resourceList.append(item);
    return;
  }
  for (const file of resources) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name;
    const size = document.createElement("span");
    size.textContent = `${Math.max(1, Math.ceil(file.size / 1024))} KB`;
    item.append(name, size);
    resourceList.append(item);
  }
}

async function chooseResources(files: File[]): Promise<void> {
  try {
    await readResources(files);
  } catch (error) {
    appendLog(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  resources = files;
  renderResources();
  await run();
}

function showToolchain(language: Language): void {
  selectedLanguage = language;
  const tool = toolchains[language];
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-language]")) {
    const active = button.dataset.language === language;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  element<HTMLElement>("#language-symbol").textContent = language === "cpp" ? "C++" : language.toUpperCase();
  element<HTMLElement>("#language-name").textContent = tool.name;
  element<HTMLElement>("#language-output").textContent = tool.output;
  element<HTMLElement>("#language-summary").textContent = tool.summary;
  element<HTMLElement>("#build-command").textContent = tool.command;
  element<HTMLElement>("#sample-button").innerHTML = `<span aria-hidden="true">◈</span> Load ${tool.name} sample <span aria-hidden="true">→</span>`;
  const links = element<HTMLElement>("#template-links");
  links.replaceChildren();
  for (const [name, path] of tool.links) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${name} →`;
    button.addEventListener("click", () => { void openSource(name, path); });
    links.append(button);
  }
  if (language === "c") {
    const preview = document.createElement("button");
    preview.type = "button";
    preview.textContent = "C API preview →";
    preview.addEventListener("click", () => { void openCDemo(); });
    links.append(preview);
  }
}

async function chooseSample(language: Language): Promise<void> {
  const tool = toolchains[language];
  selectedApp = {
    name: `${tool.name} sample application`, origin: "SAMPLE",
    load: () => fetchApp(tool.sample, tool.kind),
  };
  appName.textContent = selectedApp.name;
  appOrigin.textContent = selectedApp.origin;
  await run();
}

element<HTMLButtonElement>("#core-default").addEventListener("click", () => {
  selectedCore = undefined;
  showCoreSource();
  void run();
});
element<HTMLButtonElement>("#core-custom").addEventListener("click", () => {
  coreDrop.classList.remove("is-hidden");
  coreFile.click();
});
coreFile.addEventListener("change", () => { if (coreFile.files?.[0]) void chooseCore(coreFile.files[0]); });
appFile.addEventListener("change", () => { if (appFile.files?.[0]) void chooseApp(appFile.files[0]); });
fileDrop(coreDrop, (file) => { void chooseCore(file); });
fileDrop(element<HTMLElement>("#app-drop"), (file) => { void chooseApp(file); });
resourceFiles.addEventListener("change", () => { void chooseResources(Array.from(resourceFiles.files || [])); });
const resourceCard = element<HTMLElement>(".resources-card");
resourceCard.addEventListener("dragover", (event) => { event.preventDefault(); resourceCard.classList.add("dragging"); });
resourceCard.addEventListener("dragleave", () => resourceCard.classList.remove("dragging"));
resourceCard.addEventListener("drop", (event) => {
  event.preventDefault();
  resourceCard.classList.remove("dragging");
  if (event.dataTransfer?.files.length) void chooseResources(Array.from(event.dataTransfer.files));
});
element<HTMLButtonElement>("#app-reset").addEventListener("click", () => { void chooseSample("js"); });
element<HTMLButtonElement>("#run-button").addEventListener("click", () => { void run(); });
element<HTMLButtonElement>("#reset-button").addEventListener("click", () => { void run(); });
element<HTMLButtonElement>("#stop-button").addEventListener("click", () => {
  stop();
  appendLog("Application stopped");
});
element<HTMLButtonElement>("#clear-log").addEventListener("click", () => consoleOutput.replaceChildren());
viewportSelect.addEventListener("change", () => {
  [width, height] = viewportSelect.value.split("x").map(Number) as [number, number];
  element<HTMLElement>(".viewport-ratio").textContent = width === 320 ? "4:3" : width === 480 ? "3:2" : "5:3";
  fitDevice();
  canvas.width = width;
  canvas.height = height;
  if (running) controller.resize(width, height);
});
window.addEventListener("resize", fitDevice);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-language]")) {
  button.addEventListener("click", () => showToolchain(button.dataset.language as Language));
}
element<HTMLButtonElement>("#sample-button").addEventListener("click", () => { void chooseSample(selectedLanguage); });
const sidePanel = element<HTMLElement>("#side-panel");
const nestedSourcePanel = element<HTMLElement>("#nested-source-panel");
const appShell = element<HTMLElement>(".app-shell");
const panelTitle = element<HTMLElement>("#panel-title");
const panelDemo = element<HTMLElement>("#panel-demo");
const panelDemoFooter = element<HTMLElement>("#panel-demo-footer");
const panelSource = element<HTMLElement>("#panel-source");
const sourcePath = element<HTMLElement>("#source-path");
const sourceCode = element<HTMLElement>("#source-code");
const sourceError = element<HTMLElement>("#source-error");
const nestedSourceCode = element<HTMLElement>("#nested-source-code");
const nestedSourceError = element<HTMLElement>("#nested-source-error");
const demoError = element<HTMLElement>("#c-demo-error");
let demoAbort: AbortController | undefined;
let stopDemo: (() => void) | undefined;
let sourceAbort: AbortController | undefined;
let nestedSourceAbort: AbortController | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let nestedCloseTimer: ReturnType<typeof setTimeout> | undefined;
let panelTrigger: HTMLElement | undefined;
function showPanel(): void {
  if (document.body.classList.contains("panel-open")) return;
  if (closeTimer) clearTimeout(closeTimer);
  panelTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  sidePanel.inert = false;
  sidePanel.setAttribute("aria-hidden", "false");
  appShell.inert = true;
  document.body.classList.add("panel-open");
  element<HTMLButtonElement>("#panel-close").focus();
}
function stopPanelContent(): void {
  sourceAbort?.abort();
  sourceAbort = undefined;
  demoAbort?.abort();
  demoAbort = undefined;
  stopDemo?.();
  stopDemo = undefined;
}
function showDemoError(error: unknown): void {
  demoError.textContent = error instanceof Error ? error.message : String(error);
  demoError.hidden = false;
}
async function openCDemo(): Promise<void> {
  if (!panelDemo.hidden && document.body.classList.contains("panel-open")) return;
  stopPanelContent();
  showPanel();
  panelTitle.textContent = "C API demo";
  panelSource.hidden = true;
  panelDemo.hidden = false;
  panelDemoFooter.hidden = false;
  demoError.hidden = true;
  demoError.textContent = "";
  const abort = new AbortController();
  demoAbort = abort;
  try {
    const stop = await startCDemo(element<HTMLCanvasElement>("#c-demo-screen"), abort.signal, showDemoError);
    if (abort.signal.aborted) stop();
    else stopDemo = stop;
  } catch (error) {
    if (!abort.signal.aborted) showDemoError(error);
  }
}
async function loadSource(name: string, path: string, code: HTMLElement, errorMessage: HTMLElement,
                          signal: AbortSignal): Promise<void> {
  code.textContent = "Loading…";
  errorMessage.hidden = true;
  errorMessage.textContent = "";
  try {
    const response = await fetch(path, { signal });
    if (!response.ok) throw new Error(`Could not load ${name} (${response.status})`);
    const source = await response.text();
    if (!signal.aborted) renderHighlighted(code, source, name);
  } catch (error) {
    if (signal.aborted) return;
    code.textContent = "";
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    errorMessage.hidden = false;
  }
}
async function openSource(name: string, path: string): Promise<void> {
  stopPanelContent();
  showPanel();
  panelTitle.textContent = name;
  panelDemo.hidden = true;
  panelDemoFooter.hidden = true;
  panelSource.hidden = false;
  sourcePath.textContent = path.slice(1);
  const abort = new AbortController();
  sourceAbort = abort;
  await loadSource(name, path, sourceCode, sourceError, abort.signal);
}
async function openNestedSource(): Promise<void> {
  if (document.body.classList.contains("nested-source-open")) return;
  if (nestedCloseTimer) clearTimeout(nestedCloseTimer);
  sidePanel.inert = true;
  nestedSourcePanel.inert = false;
  nestedSourcePanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("nested-source-open");
  element<HTMLButtonElement>("#nested-source-close").focus();
  const abort = new AbortController();
  nestedSourceAbort = abort;
  await loadSource("direct_api.c", "/examples/c/direct_api.c",
    nestedSourceCode, nestedSourceError, abort.signal);
}
function closeNestedSource(): void {
  if (!document.body.classList.contains("nested-source-open")) return;
  document.body.classList.remove("nested-source-open");
  nestedSourceAbort?.abort();
  nestedSourceAbort = undefined;
  nestedCloseTimer = setTimeout(() => {
    nestedSourcePanel.inert = true;
    nestedSourcePanel.setAttribute("aria-hidden", "true");
    sidePanel.inert = false;
    element<HTMLButtonElement>("#panel-demo-source").focus();
    nestedCloseTimer = undefined;
  }, 360);
}
function closePanel(): void {
  if (!document.body.classList.contains("panel-open")) return;
  if (document.body.classList.contains("nested-source-open")) return closeNestedSource();
  if (nestedCloseTimer) return;
  document.body.classList.remove("panel-open");
  stopPanelContent();
  closeTimer = setTimeout(() => {
    sidePanel.inert = true;
    sidePanel.setAttribute("aria-hidden", "true");
    appShell.inert = false;
    if (panelTrigger?.isConnected) panelTrigger.focus();
    else document.querySelector<HTMLButtonElement>(`[data-language="${selectedLanguage}"]`)?.focus();
    closeTimer = undefined;
  }, 360);
}
element<HTMLButtonElement>("#panel-close").addEventListener("click", closePanel);
element<HTMLButtonElement>("#nested-source-close").addEventListener("click", closeNestedSource);
element<HTMLButtonElement>("#panel-demo-source").addEventListener("click", () => { void openNestedSource(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("panel-open")) closePanel();
});
element<HTMLButtonElement>("#copy-command").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(toolchains[selectedLanguage].command);
    appendLog(`${toolchains[selectedLanguage].name} build command copied`);
  } catch {
    appendLog("Clipboard is unavailable in this browser", "error");
  }
});

function point(event: PointerEvent): { x: number; y: number } {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height))),
  };
}
canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  const { x, y } = point(event);
  controller.pointer(x, y, true);
});
canvas.addEventListener("pointermove", (event) => {
  if (!(event.buttons & 1)) return;
  const { x, y } = point(event);
  controller.pointer(x, y, true);
});
canvas.addEventListener("pointerup", (event) => {
  const { x, y } = point(event);
  controller.pointer(x, y, false);
});
canvas.addEventListener("pointercancel", (event) => {
  const { x, y } = point(event);
  controller.pointer(x, y, false);
});

showToolchain("js");
fitDevice();
requestAnimationFrame(() => device.classList.add("resizable"));
void run();
