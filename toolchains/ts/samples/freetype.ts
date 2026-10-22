import {
  LV_ALIGN_CENTER, LV_EVENT_CLICKED, LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
  LV_FREETYPE_FONT_RENDER_MODE_OUTLINE, LV_FREETYPE_FONT_STYLE_NORMAL, LV_PART_MAIN,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  function createFont(size: number, renderMode: number): number {
    const bytes = new TextEncoder().encode("W:geometry.ttf\0");
    const path = raw.lvw_alloc(bytes.length);
    if (!path) return 0;
    new Uint8Array(raw.memory.buffer, path, bytes.length).set(bytes);
    const font = raw.lv_freetype_font_create(path, renderMode, size, LV_FREETYPE_FONT_STYLE_NORMAL);
    // FreeType copies the path before returning.
    raw.lvw_free(path);
    return font;
  }

  let size = 16;
  let renderMode = LV_FREETYPE_FONT_RENDER_MODE_BITMAP;
  let font = createFont(size, renderMode);
  if (!font) throw new Error("Could not create 16 px font: W:geometry.ttf");
  const label = runtime.createLabel(screen);
  raw.lv_obj_set_style_text_font(label.handle, font, LV_PART_MAIN);
  runtime.setText(label, "AB Á");
  raw.lv_obj_align(label.handle, LV_ALIGN_CENTER, 0, -24);

  const caption = runtime.createLabel(screen);
  raw.lv_obj_align(caption.handle, LV_ALIGN_CENTER, 0, 52);
  const sizeButton = runtime.createButton(screen);
  sizeButton.setSize(136, 36);
  raw.lv_obj_align(sizeButton.handle, LV_ALIGN_CENTER, -76, 88);
  const sizeLabel = runtime.createLabel(sizeButton);
  const modeButton = runtime.createButton(screen);
  modeButton.setSize(136, 36);
  raw.lv_obj_align(modeButton.handle, LV_ALIGN_CENTER, 76, 88);
  const modeLabel = runtime.createLabel(modeButton);
  function updateLabels(): void {
    const outline = renderMode === LV_FREETYPE_FONT_RENDER_MODE_OUTLINE;
    runtime.setText(caption, `${size} px / FreeType ${outline ? "outline" : "bitmap"}`);
    runtime.setText(sizeLabel, `Use ${size === 16 ? 32 : 16} px`);
    runtime.setText(modeLabel, `Use ${outline ? "bitmap" : "outline"}`);
    raw.lv_obj_center(sizeLabel.handle);
    raw.lv_obj_center(modeLabel.handle);
  }
  function replaceFont(nextSize: number, nextMode: number): void {
    const candidate = createFont(nextSize, nextMode);
    if (!candidate) {
      api.log(`Could not create ${nextSize} px ${nextMode === LV_FREETYPE_FONT_RENDER_MODE_OUTLINE ? "outline" : "bitmap"} font: W:geometry.ttf`);
      return;
    }
    raw.lv_obj_set_style_text_font(label.handle, candidate, LV_PART_MAIN);
    raw.lv_freetype_font_delete(font);
    font = candidate;
    size = nextSize;
    renderMode = nextMode;
    updateLabels();
  }
  updateLabels();
  sizeButton.on(LV_EVENT_CLICKED, () => replaceFont(size === 16 ? 32 : 16, renderMode));
  modeButton.on(LV_EVENT_CLICKED, () => replaceFont(size, renderMode === LV_FREETYPE_FONT_RENDER_MODE_BITMAP
    ? LV_FREETYPE_FONT_RENDER_MODE_OUTLINE : LV_FREETYPE_FONT_RENDER_MODE_BITMAP));
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
