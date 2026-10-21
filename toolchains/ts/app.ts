import {
  LV_COLOR_T_SIZE, LV_EVENT_CLICKED, LV_PALETTE_BLUE, LV_PALETTE_GREEN,
  LV_PART_MAIN,
} from "../../target/typescript/values.ts";
import type { AppApi } from "./api.ts";
import { requireSdk } from "./sdk.ts";

function main(api: AppApi): void {
  const { runtime } = api;
  const raw = requireSdk(runtime);
  const button = runtime.createButton(api.screen);
  raw.lv_obj_set_size(button.handle, 180, 64);
  raw.lv_obj_center(button.handle);
  const label = runtime.createLabel(button);
  let clicks = 0;

  function update(): void {
    const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
    if (!color) throw new Error("Color allocation failed");
    // Aggregate results are written into caller-owned guest memory.
    raw.lv_palette_main(color, clicks % 2 ? LV_PALETTE_GREEN : LV_PALETTE_BLUE);
    raw.lv_obj_set_style_bg_color(button.handle, color, LV_PART_MAIN);
    raw.lvw_free(color);
    runtime.setText(label, `Clicks: ${clicks}`);
    raw.lv_obj_center(label.handle);
  }

  update();
  button.on(LV_EVENT_CLICKED, () => {
    clicks++;
    update();
    api.log(`Clicks: ${clicks}`);
  });
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
