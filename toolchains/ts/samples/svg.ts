import {
  LV_ALIGN_CENTER, LV_EVENT_CLICKED, LV_SCALE_NONE,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  const scale = 4;
  const image = runtime.createImage(screen);
  raw.lv_image_set_scale(image.handle, LV_SCALE_NONE * scale);
  raw.lv_obj_align(image.handle, LV_ALIGN_CENTER, 0, -24);
  const caption = runtime.createLabel(screen);
  raw.lv_obj_align(caption.handle, LV_ALIGN_CENTER, 0, 52);
  const button = runtime.createButton(screen);
  button.setSize(164, 36);
  raw.lv_obj_align(button.handle, LV_ALIGN_CENTER, 0, 88);
  const label = runtime.createLabel(button);
  let gradient = false;

  function showSource(next: boolean): void {
    const name = next ? "gradient.svg" : "geometry.svg";
    // The image copies the file path; W: retains the resource bytes.
    runtime.setImageSource(image, `W:${name}`);
    const width = raw.lv_image_get_src_width(image.handle);
    const height = raw.lv_image_get_src_height(image.handle);
    if (!width || !height) throw new Error(`SVG resource is missing or has an invalid viewport: W:${name}`);
    raw.lv_image_set_pivot(image.handle, width / 2, height / 2);
    gradient = next;
    runtime.setText(caption, `${name} / ${width}x${height} / ${scale}x`);
    runtime.setText(label, next ? "Show geometry" : "Show gradient");
    raw.lv_obj_center(label.handle);
  }

  showSource(false);
  button.on(LV_EVENT_CLICKED, () => showSource(!gradient));
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
