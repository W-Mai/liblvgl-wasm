import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { WASI_IMPORT_NAMES } from "../../bindings/typescript/src/wasi.ts";

export type ArtifactHint = "core" | "application" | "auto";
export type ArtifactKind = "lvgl-core" | "lvw-app" | "firmware" | "unknown";
export type RunMode = "lvgl-app" | "firmware" | "unavailable";
export type CapabilityState = "available" | "missing" | "unknown" | "adapted" | "blocked";

export interface ArtifactCapability {
  id: string;
  state: CapabilityState;
  detail: string;
}

export interface ArtifactReport {
  kind: ArtifactKind;
  mode: RunMode;
  sha256: string;
  bytes: number;
  imports: string[];
  exports: string[];
  capabilities: ArtifactCapability[];
  reasons: string[];
  identity?: {
    bridgeAbi?: number;
    sdk: "matched" | "core-mismatch" | "unknown";
  };
  manifest?: {
    sourceRevision: string;
    apiSha256: string;
    configSha256: string;
    version: string;
  };
}

export const CORE_REQUIRED_IMPORTS = [
  "lvw.event", "lvw.timer", "lvw.timer_release",
  "lvw.anim_exec", "lvw.anim_query", "lvw.anim_notify", "lvw.anim_release",
  "lvw.observer", "lvw.observer_release",
  "lvw.decoder_info", "lvw.decoder_open", "lvw.decoder_area", "lvw.decoder_close", "lvw.decoder_release",
  ...WASI_IMPORT_NAMES.map((name) => `wasi_snapshot_preview1.${name}`),
] as const;

export const CORE_REQUIRED_EXPORTS = [
  "memory", "_initialize", "lvw_abi_version", "lvw_init", "lvw_shutdown",
  "lvw_alloc", "lvw_free", "lvw_display_create", "lvw_display_resize", "lvw_display_destroy",
  "lvw_indev_create", "lvw_indev_push", "lvw_step", "lvw_frame_get",
  "lvw_resource_put", "lvw_event_add", "lvw_event_remove", "lvw_event_clicked", "lvw_event_delete",
  "lv_display_get_screen_active", "lv_button_create", "lv_label_create",
  "lv_label_set_text", "lv_obj_set_size", "lv_obj_set_pos",
] as const;

export const APP_ALLOWED_IMPORTS = [
  "screen", "button", "label", "set_size", "set_pos", "set_text", "on_click", "log",
] as const;

export const APP_REQUIRED_EXPORTS = ["memory", "app_abi_version", "app_init", "app_event"] as const;

export const FIRMWARE_REQUIRED_EXPORTS = [
  "memory", "lvw_firmware_abi_version", "lvw_firmware_init", "lvw_firmware_step",
  "lvw_firmware_frame_ptr", "lvw_firmware_frame_len", "lvw_firmware_pointer", "lvw_firmware_shutdown",
] as const;

const coreImports = new Set<string>(CORE_REQUIRED_IMPORTS);
const appImports = new Set<string>(APP_ALLOWED_IMPORTS.map((name) => `lvw_app.${name}`));
const wasiImports = new Set<string>(WASI_IMPORT_NAMES.map((name) => `wasi_snapshot_preview1.${name}`));

function bytesOf(input: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  return new Uint8Array(input).slice();
}

function missing(required: readonly string[], actual: Set<string>): string[] {
  return required.filter((name) => !actual.has(name));
}

function wrongKinds(required: readonly string[], actual: Map<string, string>): string[] {
  return required.flatMap((name) => {
    const kind = actual.get(name);
    if (kind === undefined) return [];
    const expected = name === "memory" ? "memory" : "function";
    return kind === expected ? [] : [`${name} (${kind}; expected ${expected})`];
  });
}

function capability(id: string, state: CapabilityState, detail: string): ArtifactCapability {
  return { id, state, detail };
}

function hintMismatch(hint: ArtifactHint, kind: ArtifactKind): string | undefined {
  if (hint === "auto") return undefined;
  if (hint === "core" && kind !== "lvgl-core") return `Expected an LVGL core, detected ${kind}.`;
  if (hint === "application" && kind !== "lvw-app" && kind !== "firmware") {
    return `Expected an application or firmware, detected ${kind}.`;
  }
  return undefined;
}

export async function inspectArtifact(input: BufferSource, hint: ArtifactHint = "auto"): Promise<ArtifactReport> {
  const bytes = bytesOf(input);
  const sha = bytesToHex(sha256(bytes));
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes as unknown as ArrayBuffer);
  } catch (error) {
    return {
      kind: "unknown", mode: "unavailable", sha256: sha, bytes: bytes.byteLength,
      imports: [], exports: [], capabilities: [capability("wasm.module", "blocked", "The file is not a valid WebAssembly module.")],
      reasons: [error instanceof Error ? error.message : "WebAssembly compilation failed."],
    };
  }

  const imports = WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`);
  const exportEntries = WebAssembly.Module.exports(module);
  const exports = exportEntries.map((item) => item.name);
  const exportKinds = new Map(exportEntries.map((item) => [item.name, item.kind]));
  const importSet = new Set(imports);
  const exportSet = new Set(exports);
  const coreMissingExports = missing(CORE_REQUIRED_EXPORTS, exportSet);
  const coreWrongExportKinds = wrongKinds(CORE_REQUIRED_EXPORTS, exportKinds);
  const coreUnsupportedImports = imports.filter((item) => !coreImports.has(item));
  const coreMatches = coreMissingExports.length === 0 && coreWrongExportKinds.length === 0 && coreUnsupportedImports.length === 0;
  const appMissingExports = missing(APP_REQUIRED_EXPORTS, exportSet);
  const appWrongExportKinds = wrongKinds(APP_REQUIRED_EXPORTS, exportKinds);
  const appUnsupportedImports = imports.filter((item) => !appImports.has(item));
  const appMatches = appMissingExports.length === 0 && appWrongExportKinds.length === 0 && appUnsupportedImports.length === 0
    && imports.some((item) => item.startsWith("lvw_app."));
  const firmwareMissingExports = missing(FIRMWARE_REQUIRED_EXPORTS, exportSet);
  const firmwareWrongExportKinds = wrongKinds(FIRMWARE_REQUIRED_EXPORTS, exportKinds);
  const firmwareUnsupportedImports = imports.filter((item) => !wasiImports.has(item));
  const firmwareMatches = firmwareMissingExports.length === 0 && firmwareWrongExportKinds.length === 0 && firmwareUnsupportedImports.length === 0;

  let kind: ArtifactKind = "unknown";
  if (firmwareMatches) kind = "firmware";
  else if (appMatches) kind = "lvw-app";
  else if (coreMatches) kind = "lvgl-core";

  const reasons: string[] = [];
  const capabilities: ArtifactCapability[] = [
    capability("wasm.module", "available", "Valid WebAssembly module."),
    capability("wasm.memory", exportKinds.get("memory") === "memory" ? "available" : "missing",
      exportKinds.get("memory") === "memory" ? "Exports linear memory." : "Exports no linear memory."),
  ];

  if (kind === "lvgl-core") {
    capabilities.push(
      capability("lvw.bridge", "available", "Exports the LVGL bridge ABI entry points."),
      capability("lvgl.identity", "unknown", "LVGL version and configuration are not exported by this core."),
      capability("lvgl.generated-api", "unknown", "Generated API bindings require an exact matching core proof."),
    );
  } else if (kind === "lvw-app") {
    capabilities.push(capability("lvw-app.abi", "available", "Exports application ABI 1 entry points."));
  } else if (kind === "firmware") {
    capabilities.push(
      capability("lvw-firmware.abi", "available", "Exports standalone firmware ABI entry points."),
      capability("lvw-firmware.rgba8888", "available", "Firmware owns a packed RGBA8888 frame."),
    );
  } else {
    capabilities.push(capability("artifact.kind", "blocked", "No supported LVGL core, application, or firmware ABI was found."));
    if (coreMissingExports.length) reasons.push(`LVGL core is missing exports: ${coreMissingExports.join(", ")}`);
    if (coreWrongExportKinds.length) reasons.push(`LVGL core has wrong export kinds: ${coreWrongExportKinds.join(", ")}`);
    if (coreUnsupportedImports.length) reasons.push(`LVGL core has unsupported imports: ${coreUnsupportedImports.join(", ")}`);
    if (appMissingExports.length) reasons.push(`Application is missing exports: ${appMissingExports.join(", ")}`);
    if (appWrongExportKinds.length) reasons.push(`Application has wrong export kinds: ${appWrongExportKinds.join(", ")}`);
    if (appUnsupportedImports.length) reasons.push(`Application has unsupported imports: ${appUnsupportedImports.join(", ")}`);
    if (firmwareMissingExports.length) reasons.push(`Firmware is missing exports: ${firmwareMissingExports.join(", ")}`);
    if (firmwareWrongExportKinds.length) reasons.push(`Firmware has wrong export kinds: ${firmwareWrongExportKinds.join(", ")}`);
    if (firmwareUnsupportedImports.length) reasons.push(`Firmware has unsupported imports: ${firmwareUnsupportedImports.join(", ")}`);
  }

  const mismatch = hintMismatch(hint, kind);
  if (mismatch) {
    reasons.push(mismatch);
    capabilities.push(capability("requested-slot", "blocked", mismatch));
  }

  const mode: RunMode = !mismatch && kind === "firmware" ? "firmware"
    : !mismatch && (kind === "lvgl-core" || kind === "lvw-app") ? "lvgl-app" : "unavailable";
  if (mode === "unavailable" && !reasons.length) reasons.push("The artifact cannot run in the selected slot.");

  return { kind, mode, sha256: sha, bytes: bytes.byteLength, imports, exports, capabilities, reasons,
    identity: kind === "lvgl-core" ? { sdk: "unknown" } : undefined };
}

