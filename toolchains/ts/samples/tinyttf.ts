import {
  LV_ALIGN_CENTER, LV_EVENT_CLICKED, LV_PART_MAIN, LV_STYLE_TEXT_FONT,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  const bytes = new TextEncoder().encode("W:geometry.ttf\0");
  const sizeBytes = Uint32Array.BYTES_PER_ELEMENT;
  const scratch = raw.lvw_alloc(sizeBytes + bytes.length);
  if (!scratch) throw new Error("Font load allocation failed: W:geometry.ttf");
  const path = scratch + sizeBytes;
  new Uint8Array(raw.memory.buffer, path, bytes.length).set(bytes);
  const data = raw.lv_fs_load_with_alloc(path, scratch);
  const length = data ? new DataView(raw.memory.buffer).getUint32(scratch, true) : 0;
  raw.lvw_free(scratch);
  if (!data) throw new Error("Could not load font: W:geometry.ttf");

  let size = 16;
  // TinyTTF borrows the complete buffer; Studio discards the whole runtime on Stop.
  const font = raw.lv_tiny_ttf_create_data(data, length, size);
  if (!font) {
    raw.lv_free(data);
    throw new Error("Could not create 16 px TinyTTF font: W:geometry.ttf");
  }
  const label = runtime.createLabel(screen);
  raw.lv_obj_set_style_text_font(label.handle, font, LV_PART_MAIN);
  runtime.setText(label, "AB Á");
  raw.lv_obj_align(label.handle, LV_ALIGN_CENTER, 0, -24);

  const caption = runtime.createLabel(screen);
  raw.lv_obj_align(caption.handle, LV_ALIGN_CENTER, 0, 52);
  const button = runtime.createButton(screen);
  button.setSize(164, 36);
  raw.lv_obj_align(button.handle, LV_ALIGN_CENTER, 0, 88);
  const buttonLabel = runtime.createLabel(button);
  function updateLabels(): void {
    runtime.setText(caption, `${size} px / TinyTTF`);
    runtime.setText(buttonLabel, `Use ${size === 16 ? 32 : 16} px`);
    raw.lv_obj_center(buttonLabel.handle);
  }
  updateLabels();
  button.on(LV_EVENT_CLICKED, () => {
    const nextSize = size === 16 ? 32 : 16;
    raw.lv_tiny_ttf_set_size(font, nextSize);
    raw.lv_obj_refresh_style(label.handle, LV_PART_MAIN, LV_STYLE_TEXT_FONT);
    size = nextSize;
    updateLabels();
  });
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
