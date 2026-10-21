import {
  LV_ALIGN_CENTER, LV_COLOR_T_SIZE, LV_EVENT_CLICKED, LV_OPA_COVER,
  LV_PART_MAIN, LV_SCALE_NONE,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  const scale = 16;
  const image = runtime.createImage(screen);
  runtime.setImageSource(image, "W:rgba.png");
  const width = raw.lv_image_get_src_width(image.handle);
  const height = raw.lv_image_get_src_height(image.handle);
  if (!width || !height) throw new Error("PNG resource is missing or has an invalid header: W:rgba.png");
  raw.lv_image_set_scale(image.handle, LV_SCALE_NONE * scale);
  raw.lv_image_set_antialias(image.handle, 0);
  raw.lv_obj_align(image.handle, LV_ALIGN_CENTER, 0, -24);

  const caption = runtime.createLabel(screen);
  runtime.setText(caption, `${width}x${height} PNG / ${scale}x`);
  raw.lv_obj_align(caption.handle, LV_ALIGN_CENTER, 0, 52);
  const button = runtime.createButton(screen);
  button.setSize(164, 36);
  raw.lv_obj_align(button.handle, LV_ALIGN_CENTER, 0, 88);
  const label = runtime.createLabel(button);
  let dark = false;

  function updateBackground(): void {
    const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
    if (!color) throw new Error("Color allocation failed");
    raw.lv_color_hex(color, dark ? 0x202020 : 0xf0f0f0);
    raw.lv_obj_set_style_bg_color(screen.handle, color, LV_PART_MAIN);
    raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
    raw.lv_color_hex(color, dark ? 0xf0f0f0 : 0x202020);
    raw.lv_obj_set_style_text_color(caption.handle, color, LV_PART_MAIN);
    raw.lvw_free(color);
    runtime.setText(label, dark ? "Light background" : "Dark background");
    raw.lv_obj_center(label.handle);
  }

  updateBackground();
  button.on(LV_EVENT_CLICKED, () => {
    dark = !dark;
    updateBackground();
  });
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
