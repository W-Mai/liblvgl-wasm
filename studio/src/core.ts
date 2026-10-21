import { WASI_IMPORT_NAMES } from "../../bindings/typescript/src/wasi.ts";
import type { RuntimeIdentity } from "../../bindings/typescript/src/index.ts";
import {
  valuesIdentity, LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR, LVGL_VERSION_PATCH,
  LV_USE_LODEPNG, LV_USE_BMP, LV_USE_GIF, LV_USE_TINY_TTF, LV_USE_FREETYPE,
  LV_USE_VECTOR_GRAPHIC, LV_USE_SVG, LV_USE_LOTTIE,
} from "../../target/typescript/values.ts";

const requiredImports = new Set([
  "lvw.event",
  "lvw.timer",
  "lvw.timer_release",
  "lvw.anim_exec",
  "lvw.anim_query",
  "lvw.anim_notify",
  "lvw.anim_release",
  "lvw.observer",
  "lvw.observer_release",
  "lvw.decoder_info",
  "lvw.decoder_open",
  "lvw.decoder_area",
  "lvw.decoder_close",
  "lvw.decoder_release",
  ...WASI_IMPORT_NAMES.map((name) => `wasi_snapshot_preview1.${name}`),
]);

const requiredExports = [
  "memory", "_initialize", "lvw_abi_version", "lvw_init", "lvw_shutdown",
  "lvw_alloc", "lvw_free", "lvw_display_create", "lvw_display_resize", "lvw_display_destroy",
  "lvw_indev_create", "lvw_indev_push", "lvw_step", "lvw_frame_get",
  "lvw_resource_put", "lvw_event_add", "lvw_event_remove", "lvw_event_clicked", "lvw_event_delete",
  "lv_display_get_screen_active", "lv_button_create", "lv_label_create",
  "lv_label_set_text", "lv_obj_set_size", "lv_obj_set_pos",
];

export interface CoreInfo {
  imports: string[];
  exports: string[];
}

export interface CoreReport {
  identity: RuntimeIdentity;
  imports: number;
  exports: number;
  build: {
    version: string;
    features: { name: string; enabled: boolean }[];
  } | null;
}

/** Configuration belongs only to the exact core described by these generated values. */
export function describeCore(identity: RuntimeIdentity, info: CoreInfo): CoreReport {
  const matched = identity.sdk.status === "matched"
    && identity.coreSha256 === valuesIdentity.wasm_sha256
    && identity.sdk.apiSha256 === valuesIdentity.api_sha256;
  const features: [string, number][] = [
    ["PNG", LV_USE_LODEPNG], ["BMP", LV_USE_BMP], ["GIF", LV_USE_GIF],
    ["TinyTTF", LV_USE_TINY_TTF], ["FreeType", LV_USE_FREETYPE],
    ["Vector graphics", LV_USE_VECTOR_GRAPHIC], ["SVG geometry", LV_USE_SVG],
    ["Lottie", LV_USE_LOTTIE],
  ];
  return {
    identity, imports: info.imports.length, exports: info.exports.length,
    build: matched ? {
      version: `${LVGL_VERSION_MAJOR}.${LVGL_VERSION_MINOR}.${LVGL_VERSION_PATCH}`,
      features: features.map(([name, value]) => ({ name, enabled: value !== 0 })),
    } : null,
  };
}

export async function inspectCore(bytes: BufferSource): Promise<CoreInfo> {
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`);
  const unsupported = imports.filter((item) => !requiredImports.has(item));
  if (unsupported.length) throw new Error(`Unsupported core imports: ${unsupported.join(", ")}`);

  const exports = WebAssembly.Module.exports(module).map((item) => item.name);
  const missing = requiredExports.filter((item) => !exports.includes(item));
  if (missing.length) throw new Error(`Core is missing required exports: ${missing.join(", ")}`);
  return { imports, exports };
}
