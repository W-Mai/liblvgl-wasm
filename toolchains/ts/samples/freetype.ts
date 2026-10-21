import {
  LV_ALIGN_CENTER, LV_EVENT_CLICKED, LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
  LV_FREETYPE_FONT_STYLE_NORMAL, LV_PART_MAIN,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  function createFont(size: number): number {
    const bytes = new TextEncoder().encode("W:geometry.ttf\0");
    const path = raw.lvw_alloc(bytes.length);
    if (!path) return 0;
    new Uint8Array(raw.memory.buffer, path, bytes.length).set(bytes);
    const font = raw.lv_freetype_font_create(path, LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
      size, LV_FREETYPE_FONT_STYLE_NORMAL);
    // FreeType copies the path before returning.
    raw.lvw_free(path);
    return font;
  }

  let size = 16;
  let font = createFont(size);
  if (!font) throw new Error("Could not create 16 px font: W:geometry.ttf");
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
    runtime.setText(caption, `${size} px / FreeType bitmap`);
    runtime.setText(buttonLabel, `Use ${size === 16 ? 32 : 16} px`);
    raw.lv_obj_center(buttonLabel.handle);
  }
  updateLabels();
  button.on(LV_EVENT_CLICKED, () => {
    const nextSize = size === 16 ? 32 : 16;
    const candidate = createFont(nextSize);
    if (!candidate) {
      api.log(`Could not create ${nextSize} px font: W:geometry.ttf`);
      return;
    }
    raw.lv_obj_set_style_text_font(label.handle, candidate, LV_PART_MAIN);
    raw.lv_freetype_font_delete(font);
    font = candidate;
    size = nextSize;
    updateLabels();
  });
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
