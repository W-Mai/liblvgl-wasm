import { StudioController } from "./controller.ts";
import { startCDemo } from "./c-demo.ts";
import { inspectCore, type CoreReport } from "./core.ts";
import { renderHighlighted } from "./highlight.ts";
import { loadResources, readResources, type ResourceFile } from "./resources.ts";
import type { AppSource, RunnerOutput } from "./protocol.ts";

type Language = "js" | "ts" | "c" | "cpp" | "rust";
type Source = {
  name: string; origin: string; resources?: readonly ResourceFile[];
  load(): Promise<AppSource>;
};

type Toolchain = {
  name: string; output: string; summary: string; command: string;
  sample: string; kind: "js" | "wasm"; links: [string, string][];
  sampleName?: string; resources?: readonly ResourceFile[];
};

const toolchains: Record<Language, Toolchain> = {
  js: {
    name: "JavaScript", output: "Upload .js",
    summary: "Write a single JavaScript file with a main(api) entry point. No compilation needed.",
    command: "No build step — upload toolchains/js/app.js",
    sample: "/toolchains/js/app.js", kind: "js",
    links: [["app.js", "/toolchains/js/app.js"]],
  },
  ts: {
    name: "TypeScript", output: "Build to .js", sampleName: "API button",
    summary: "Call LVGL APIs with generated constants and layouts. Handle clicks through the host SDK.",
    command: "bun run build:ts-app\n# upload target/apps/ts/app.js",
    sample: "/target/apps/ts/app.js", kind: "js",
    links: [["app.ts", "/toolchains/ts/app.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"]],
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

const tsSamples: Record<string, Toolchain> = {
  api: toolchains.ts,
  png: {
    ...toolchains.ts, sampleName: "PNG",
    summary: "Render a PNG from W: resources with alpha transparency.",
    command: "bun run build:ts-samples\n# upload target/apps/ts/samples/png.js",
    sample: "/target/apps/ts/samples/png.js",
    links: [["png.ts", "/toolchains/ts/samples/png.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"]],
    resources: [{ name: "rgba.png", url: "/tests/fixtures/png/rgba.png" }],
  },
  gif: {
    ...toolchains.ts, sampleName: "GIF",
    summary: "Play a GIF from W: resources. Pause, resume, or restart playback.",
    command: "bun run build:ts-samples\n# upload target/apps/ts/samples/gif.js",
    sample: "/target/apps/ts/samples/gif.js",
    links: [["gif.ts", "/toolchains/ts/samples/gif.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"]],
    resources: [{ name: "playback.gif", url: "/tests/fixtures/gif/playback.gif" }],
  },
  freetype: {
    ...toolchains.ts, sampleName: "FreeType",
    summary: "Render a TrueType font as bitmap or outline glyphs. Switch between 16 and 32 px.",
    command: "bun run build:ts-samples\n# upload target/apps/ts/samples/freetype.js",
    sample: "/target/apps/ts/samples/freetype.js",
    links: [["freetype.ts", "/toolchains/ts/samples/freetype.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"]],
    resources: [{ name: "geometry.ttf", url: "/tests/fixtures/tinyttf/geometry.ttf" }],
  },
  tinyttf: {
    ...toolchains.ts, sampleName: "TinyTTF",
    summary: "Load TrueType font bytes from W: resources. Resize the font between 16 and 32 px.",
    command: "bun run build:ts-samples\n# upload target/apps/ts/samples/tinyttf.js",
    sample: "/target/apps/ts/samples/tinyttf.js",
    links: [["tinyttf.ts", "/toolchains/ts/samples/tinyttf.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"]],
    resources: [{ name: "geometry.ttf", url: "/tests/fixtures/tinyttf/geometry.ttf" }],
  },
  svg: {
    ...toolchains.ts, sampleName: "SVG",
    summary: "Render SVG geometry and gradients from W: resources at 4× scale.",
    command: "bun run build:ts-samples\n# upload target/apps/ts/samples/svg.js",
    sample: "/target/apps/ts/samples/svg.js",
    links: [["svg.ts", "/toolchains/ts/samples/svg.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"],
      ["geometry.svg", "/tests/fixtures/svg/geometry.svg"], ["gradient.svg", "/tests/fixtures/svg/gradient.svg"]],
    resources: [
      { name: "geometry.svg", url: "/tests/fixtures/svg/geometry.svg" },
      { name: "gradient.svg", url: "/tests/fixtures/svg/gradient.svg" },
    ],
  },
  lottie: {
    ...toolchains.ts, sampleName: "Lottie",
    summary: "Play a Lottie JSON resource. Pause, resume, or restart playback.",
    command: "bun run build:ts-samples\n# upload target/apps/ts/samples/lottie.js",
    sample: "/target/apps/ts/samples/lottie.js",
    links: [["lottie.ts", "/toolchains/ts/samples/lottie.ts"], ["api.ts", "/toolchains/ts/api.ts"], ["sdk.ts", "/toolchains/ts/sdk.ts"],
      ["translation-opacity.json", "/tests/fixtures/lottie/translation-opacity.json"]],
    resources: [{ name: "translation-opacity.json", url: "/tests/fixtures/lottie/translation-opacity.json" }],
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
const clearResources = element<HTMLButtonElement>("#clear-resources");
const tsSample = element<HTMLSelectElement>("#ts-sample");
for (const [value, sample] of Object.entries(tsSamples)) {
  tsSample.add(new Option(sample.sampleName, value));
}
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
let coreChoice = 0;
let resourceChoice = 0;

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
    renderCore(message.core);
    setStatus("running", "Application running");
    appendLog(`Core ABI ${message.core.identity.bridgeAbi} ready · ${message.core.exports} exports · ${message.width} × ${message.height}`, "success");
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
    renderCore();
    controller.stop();
    setStatus("error", "Application error");
    appendLog(message.message, "error");
  }
}

const controller = new StudioController(onOutput);

async function fetchBuffer(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path, { cache: "no-store" });
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
  renderCore();
  setStatus("stopped", "Application stopped");
}

async function run(): Promise<"started" | "failed" | "cancelled"> {
  stop();
  const runId = generation;
  const source = selectedApp;
  const uploads = [...resources];
  const library = selectedCore;
  setStatus("starting", "Loading application");
  appendLog(`Starting ${source.name} with ${library?.name || "default liblvgl.wasm"}…`);
  try {
    const [core, app, assets] = await Promise.all([
      library ? library.arrayBuffer() : fetchBuffer("/target/wasm/liblvgl.wasm"),
      source.load(), loadResources(source.resources ?? [], uploads),
    ]);
    if (runId !== generation) return "cancelled";
    await controller.start({ core, app, resources: assets, width, height });
    return runId === generation ? "started" : "cancelled";
  } catch (error) {
    if (runId !== generation) return "cancelled";
    controller.stop();
    renderCore();
    setStatus("error", "Application failed to start");
    appendLog(error instanceof Error ? error.message : String(error), "error");
    return "failed";
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
  const choice = ++coreChoice;
  const runId = generation;
  if (!file.name.toLowerCase().endsWith(".wasm") || file.size === 0 || file.size > 32 * 1024 * 1024) {
    appendLog("Choose a .wasm library between 1 byte and 32 MiB", "error");
    return;
  }
  try {
    await inspectCore(await file.arrayBuffer());
  } catch (error) {
    if (choice !== coreChoice || runId !== generation) return;
    appendLog(`Library rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (choice !== coreChoice || runId !== generation) return;
  const previous = selectedCore;
  selectedCore = file;
  showCoreSource();
  if (await run() === "failed" && selectedCore === file) {
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
  showAppSource();
  if (await run() === "failed" && selectedApp === candidate) {
    selectedApp = previous;
    showAppSource();
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

function showAppSource(): void {
  appName.textContent = selectedApp.name;
  appOrigin.textContent = selectedApp.origin;
  renderResources();
}

function renderResources(): void {
  resourceList.replaceChildren();
  clearResources.disabled = resources.length === 0;
  const entries = [
    ...(selectedApp.resources ?? []).map(({ name }) => ({ name, detail: "Sample" })),
    ...resources.map(({ name, size }) => ({ name, detail: `Upload · ${Math.max(1, Math.ceil(size / 1024))} KB` })),
  ];
  if (!entries.length) {
    const item = document.createElement("li");
    item.className = "empty-resource";
    item.textContent = "No assets added";
    resourceList.append(item);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.name;
    const detail = document.createElement("span");
    detail.textContent = entry.detail;
    item.append(name, detail);
    resourceList.append(item);
  }
}

async function chooseResources(files: File[]): Promise<void> {
  const choice = ++resourceChoice;
  const runId = generation;
  try {
    await readResources(files);
  } catch (error) {
    if (choice !== resourceChoice || runId !== generation) return;
    appendLog(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  if (choice !== resourceChoice || runId !== generation) return;
  resources = files;
  renderResources();
  await run();
}

function currentToolchain(language: Language): Toolchain {
  return language === "ts" ? tsSamples[tsSample.value] ?? toolchains.ts : toolchains[language];
}

function showToolchain(language: Language): void {
  selectedLanguage = language;
  const tool = currentToolchain(language);
  element<HTMLElement>("#sample-picker").hidden = language !== "ts";
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
  element<HTMLElement>("#sample-button").innerHTML = `<span aria-hidden="true">◈</span> Load ${tool.sampleName ?? tool.name} sample <span aria-hidden="true">→</span>`;
  const required = element<HTMLElement>("#sample-resources");
  required.hidden = !tool.resources?.length;
  required.textContent = (tool.resources ?? []).map(({ name, url }) => `${url.slice(1)} → W:${name}`).join("\n");
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
  const tool = currentToolchain(language);
  selectedApp = {
    name: `${tool.name}${tool.sampleName ? ` ${tool.sampleName}` : ""} sample application`, origin: "SAMPLE",
    resources: tool.resources,
    load: () => fetchApp(tool.sample, tool.kind),
  };
  showAppSource();
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
coreFile.addEventListener("change", () => {
  const file = coreFile.files?.[0];
  coreFile.value = "";
  if (file) void chooseCore(file);
});
appFile.addEventListener("change", () => {
  const file = appFile.files?.[0];
  appFile.value = "";
  if (file) void chooseApp(file);
});
fileDrop(coreDrop, (file) => { void chooseCore(file); });
fileDrop(element<HTMLElement>("#app-drop"), (file) => { void chooseApp(file); });
resourceFiles.addEventListener("change", () => {
  const files = Array.from(resourceFiles.files || []);
  resourceFiles.value = "";
  if (files.length) void chooseResources(files);
});
clearResources.addEventListener("click", () => {
  resourceChoice++;
  resourceFiles.value = "";
  resources = [];
  renderResources();
  void run();
});
tsSample.addEventListener("change", () => showToolchain(selectedLanguage));
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
  const [nextWidth, nextHeight] = viewportSelect.value.split("x").map(Number) as [number, number];
  if (width === nextWidth && height === nextHeight) return;
  [width, height] = [nextWidth, nextHeight];
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
const panelLibrary = element<HTMLElement>("#panel-library");
const coreDetails = element<HTMLButtonElement>("#core-details");
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
function renderCore(info?: CoreReport): void {
  coreDetails.disabled = !info;
  const sdkStatus = info?.identity.sdk.status;
  element<HTMLElement>("#core-sdk-status").textContent = !info ? "No active library"
    : sdkStatus === "matched" ? "Host SDK matched"
    : sdkStatus === "core-mismatch" ? "Bridge only" : "Host SDK mismatch";
  panelLibrary.replaceChildren();
  const paragraph = (text: string): void => {
    const node = document.createElement("p");
    node.textContent = text;
    panelLibrary.append(node);
  };
  if (!info) return paragraph("No active library.");
  const heading = (text: string): void => {
    const node = document.createElement("h3");
    node.textContent = text;
    panelLibrary.append(node);
  };
  const rows = (items: [string, string][], className = ""): void => {
    const list = document.createElement("dl");
    list.className = className;
    for (const [name, value] of items) {
      const term = document.createElement("dt");
      term.textContent = name;
      const description = document.createElement("dd");
      description.textContent = value;
      list.append(term, description);
    }
    panelLibrary.append(list);
  };
  rows([
    ["Bridge ABI", String(info.identity.bridgeAbi)],
    ["Host SDK", sdkStatus === "matched" ? "Matched" : "Mismatch"],
    ["Imports / exports", `${info.imports} / ${info.exports}`],
  ]);
  if (sdkStatus !== "matched") paragraph("Generated APIs need a matching SDK. Bridge applications remain available.");
  heading("Build configuration");
  if (info.build) {
    rows([["LVGL", info.build.version],
      ["Generated APIs", String(info.identity.sdk.verifiedFunctions)],
      ...info.build.features.map(({ name, enabled }): [string, string] => [name, enabled ? "Enabled" : "Disabled"])]);
  } else paragraph("Unknown for this core.");
  heading("Identity");
  const hashes: [string, string][] = [["Loaded core · SHA-256", info.identity.coreSha256]];
  if (sdkStatus !== "matched") hashes.push(["SDK core · SHA-256", info.identity.sdk.coreSha256]);
  hashes.push(["SDK API · SHA-256", info.identity.sdk.apiSha256]);
  rows(hashes, "library-hashes");
}
function openCoreDetails(): void {
  stopPanelContent();
  showPanel();
  panelTitle.textContent = "Library details";
  panelDemo.hidden = true;
  panelDemoFooter.hidden = true;
  panelSource.hidden = true;
  panelLibrary.hidden = false;
}
coreDetails.addEventListener("click", openCoreDetails);
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
  panelLibrary.hidden = true;
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
                          signal: AbortSignal, refresh = false): Promise<void> {
  if (!refresh) code.textContent = "Loading…";
  errorMessage.hidden = true;
  errorMessage.textContent = "";
  try {
    const response = await fetch(path, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load ${name} (${response.status})`);
    const source = await response.text();
    if (!signal.aborted && code.textContent !== source) renderHighlighted(code, source, name);
  } catch (error) {
    if (signal.aborted) return;
    if (!refresh) code.textContent = "";
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    errorMessage.hidden = false;
  }
}
function refreshVisibleSource(): void {
  if (document.hidden) return;
  if (document.body.classList.contains("nested-source-open")) {
    nestedSourceAbort?.abort();
    const abort = new AbortController();
    nestedSourceAbort = abort;
    void loadSource("direct_api.c", "/examples/c/direct_api.c",
      nestedSourceCode, nestedSourceError, abort.signal, true);
  } else if (document.body.classList.contains("panel-open") && !panelSource.hidden) {
    sourceAbort?.abort();
    const abort = new AbortController();
    sourceAbort = abort;
    void loadSource(panelTitle.textContent || "source", `/${sourcePath.textContent}`,
      sourceCode, sourceError, abort.signal, true);
  }
}
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  setInterval(refreshVisibleSource, 3000);
  window.addEventListener("focus", refreshVisibleSource);
  document.addEventListener("visibilitychange", refreshVisibleSource);
}
async function openSource(name: string, path: string): Promise<void> {
  stopPanelContent();
  showPanel();
  panelTitle.textContent = name;
  panelDemo.hidden = true;
  panelDemoFooter.hidden = true;
  panelSource.hidden = false;
  panelLibrary.hidden = true;
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
    if (panelTrigger?.isConnected && !panelTrigger.matches(":disabled")) panelTrigger.focus();
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
    await navigator.clipboard.writeText(currentToolchain(selectedLanguage).command);
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
