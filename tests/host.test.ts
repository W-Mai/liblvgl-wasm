import { expect, test } from "bun:test";
import { LvglRuntime } from "../bindings/typescript/src/index.ts";

test("Wasm host renders a resource and handles pointer events", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer();
  const runtime = await LvglRuntime.load(bytes);
  const display = runtime.createDisplay(320, 240);
  const pointer = runtime.createPointer(display);
  const screen = runtime.screen(display);

  runtime.putResource("red.bmp", await Bun.file("examples/browser/red.bmp").bytes());
  const image = runtime.createImage(screen);
  runtime.setImageSource(image, "W:red.bmp");
  image.setPosition(8, 8);

  const button = runtime.createButton(screen);
  button.setSize(140, 60);
  button.setPosition(90, 80);
  const label = runtime.createLabel(button);
  runtime.setText(label, "Click me");
  let clicked = 0;
  button.on(runtime.clickedEvent, () => {
    clicked++;
    runtime.setText(label, "Clicked");
  });

  for (let index = 0; index < 5; index++) runtime.step(50);
  const frame = runtime.readFrame(display);
  expect(frame.width).toBe(320);
  expect(frame.height).toBe(240);
  expect(frame.frameId).toBeGreaterThan(0);
  const red = (8 * frame.width + 8) * 4;
  expect([...frame.rgba.slice(red, red + 3)]).toEqual([255, 0, 0]);

  pointer.push(120, 100, true);
  runtime.step(50);
  pointer.push(120, 100, false);
  runtime.step(50);
  expect(clicked).toBe(1);

  display.destroy();
  runtime.shutdown();
});
