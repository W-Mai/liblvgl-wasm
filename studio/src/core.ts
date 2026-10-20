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
  "wasi_snapshot_preview1.fd_close",
  "wasi_snapshot_preview1.fd_seek",
  "wasi_snapshot_preview1.fd_write",
]);

const requiredExports = [
  "memory", "_initialize", "lvw_abi_version", "lvw_init", "lvw_shutdown",
  "lvw_alloc", "lvw_free", "lvw_display_create", "lvw_display_destroy",
  "lvw_indev_create", "lvw_indev_push", "lvw_step", "lvw_frame_get",
  "lvw_resource_put", "lvw_event_add", "lvw_event_remove", "lvw_event_clicked", "lvw_event_delete",
  "lv_display_get_screen_active", "lv_button_create", "lv_label_create",
  "lv_label_set_text", "lv_obj_set_size", "lv_obj_set_pos",
];

export interface CoreInfo {
  imports: string[];
  exports: string[];
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
