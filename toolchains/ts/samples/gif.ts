import {
  LV_ALIGN_CENTER, LV_EVENT_CLICKED, LV_SCALE_NONE,
} from "../../../target/typescript/values.ts";
import type { AppApi } from "../api.ts";
import { requireSdk } from "../sdk.ts";

function main(api: AppApi): void {
  const { runtime, screen } = api;
  const raw = requireSdk(runtime);
  const bytes = new TextEncoder().encode("W:playback.gif\0");
  const path = raw.lvw_alloc(bytes.length);
  if (!path) throw new Error("GIF path allocation failed");
  new Uint8Array(raw.memory.buffer, path, bytes.length).set(bytes);
  const gif = raw.lv_gif_create(screen.handle);
  if (!gif) {
    raw.lvw_free(path);
    throw new Error("GIF object creation failed");
  }
  // GIF borrows the path until deletion; Studio discards the whole runtime on Stop.
  raw.lv_gif_set_src(gif, path);
  if (!raw.lv_gif_is_loaded(gif)) {
    raw.lv_obj_delete(gif);
    raw.lvw_free(path);
    throw new Error("GIF resource is missing or could not be opened: W:playback.gif");
  }

  const scale = 16;
  raw.lv_image_set_scale(gif, LV_SCALE_NONE * scale);
  raw.lv_image_set_antialias(gif, 0);
  raw.lv_obj_align(gif, LV_ALIGN_CENTER, 0, -24);
  const width = raw.lv_image_get_src_width(gif);
  const height = raw.lv_image_get_src_height(gif);
  const caption = runtime.createLabel(screen);
  runtime.setText(caption, `${width}x${height} GIF / ${scale}x`);
  raw.lv_obj_align(caption.handle, LV_ALIGN_CENTER, 0, 52);

  const pause = runtime.createButton(screen);
  pause.setSize(96, 36);
  raw.lv_obj_align(pause.handle, LV_ALIGN_CENTER, -56, 88);
  const pauseLabel = runtime.createLabel(pause);
  let paused = false;
  function updatePauseLabel(): void {
    runtime.setText(pauseLabel, paused ? "Resume" : "Pause");
    raw.lv_obj_center(pauseLabel.handle);
  }
  updatePauseLabel();
  pause.on(LV_EVENT_CLICKED, () => {
    if (paused) raw.lv_gif_resume(gif);
    else raw.lv_gif_pause(gif);
    paused = !paused;
    updatePauseLabel();
  });

  const restart = runtime.createButton(screen);
  restart.setSize(96, 36);
  raw.lv_obj_align(restart.handle, LV_ALIGN_CENTER, 56, 88);
  const restartLabel = runtime.createLabel(restart);
  runtime.setText(restartLabel, "Restart");
  raw.lv_obj_center(restartLabel.handle);
  restart.on(LV_EVENT_CLICKED, () => {
    raw.lv_gif_restart(gif);
    raw.lv_gif_set_loop_count(gif, 0);
    paused = false;
    updatePauseLabel();
  });
}

(globalThis as typeof globalThis & { main?: (api: AppApi) => void }).main = main;
