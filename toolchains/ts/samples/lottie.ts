import {
  LV_ALIGN_CENTER, LV_COLOR_FORMAT_ARGB8888, LV_EVENT_CLICKED, LV_STRIDE_AUTO,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  const bytes = new TextEncoder().encode("W:translation-opacity.json\0");
  function sourcePath(): number {
    const path = raw.lvw_alloc(bytes.length);
    if (path) new Uint8Array(raw.memory.buffer, path, bytes.length).set(bytes);
    return path;
  }

  const path = sourcePath();
  if (!path) throw new Error("Lottie path allocation failed");
  const buffer = raw.lv_draw_buf_create(128, 96, LV_COLOR_FORMAT_ARGB8888, LV_STRIDE_AUTO);
  if (!buffer) {
    raw.lvw_free(path);
    throw new Error("Lottie draw buffer allocation failed");
  }
  const lottie = raw.lv_lottie_create(screen.handle);
  if (!lottie) {
    raw.lv_draw_buf_destroy(buffer);
    raw.lvw_free(path);
    throw new Error("Lottie object creation failed");
  }
  raw.lv_lottie_set_draw_buf(lottie, buffer);
  // The constructor already creates an animation; only a loaded source sets its duration.
  const initial = raw.lv_lottie_get_anim(lottie);
  if (initial) raw.lv_anim_set_duration(initial, 0);
  raw.lv_lottie_set_src_file(lottie, path);
  raw.lvw_free(path);
  const loaded = raw.lv_lottie_get_anim(lottie);
  if (!loaded || !raw.lv_anim_get_time(loaded)) {
    raw.lv_obj_delete(lottie);
    raw.lv_draw_buf_destroy(buffer);
    throw new Error("Lottie resource is missing or invalid: W:translation-opacity.json");
  }
  // The widget borrows the draw buffer; Studio discards the whole runtime on Stop.
  raw.lv_obj_align(lottie, LV_ALIGN_CENTER, 0, -24);
  const caption = runtime.createLabel(screen);
  runtime.setText(caption, "32x24 / 16 fps / 4x");
  raw.lv_obj_align(caption.handle, LV_ALIGN_CENTER, 0, 52);

  const pause = runtime.createButton(screen);
  pause.setSize(136, 36);
  raw.lv_obj_align(pause.handle, LV_ALIGN_CENTER, -76, 88);
  const pauseLabel = runtime.createLabel(pause);
  function updatePauseLabel(): void {
    const anim = raw.lv_lottie_get_anim(lottie);
    runtime.setText(pauseLabel, anim && raw.lv_anim_is_paused(anim) ? "Resume" : "Pause");
    raw.lv_obj_center(pauseLabel.handle);
  }
  updatePauseLabel();
  pause.on(LV_EVENT_CLICKED, () => {
    const anim = raw.lv_lottie_get_anim(lottie);
    if (anim) {
      if (raw.lv_anim_is_paused(anim)) raw.lv_anim_resume(anim);
      else raw.lv_anim_pause(anim);
    }
    updatePauseLabel();
  });

  const restart = runtime.createButton(screen);
  restart.setSize(136, 36);
  raw.lv_obj_align(restart.handle, LV_ALIGN_CENTER, 76, 88);
  const restartLabel = runtime.createLabel(restart);
  runtime.setText(restartLabel, "Restart");
  raw.lv_obj_center(restartLabel.handle);
  restart.on(LV_EVENT_CLICKED, () => {
    const nextPath = sourcePath();
    if (!nextPath) {
      api.log("Lottie path allocation failed");
      return;
    }
    raw.lv_lottie_set_src_file(lottie, nextPath);
    raw.lvw_free(nextPath);
    updatePauseLabel();
  });
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
