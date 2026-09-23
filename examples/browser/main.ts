import { LvglRuntime } from "../../bindings/typescript/src/index.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#screen");
if (!canvas) throw new Error("missing canvas");
const context = canvas.getContext("2d");
if (!context) throw new Error("2D canvas is unavailable");

const bytes = await fetch("/target/wasm/liblvgl.wasm").then((response) => response.arrayBuffer());
const runtime = await LvglRuntime.load(bytes);
const display = runtime.createDisplay(canvas.width, canvas.height);
const pointer = runtime.createPointer(display);
const screen = runtime.screen(display);
runtime.putResource("red.bmp", new Uint8Array(await fetch("/examples/browser/red.bmp")
  .then((response) => response.arrayBuffer())));
const image = runtime.createImage(screen);
runtime.setImageSource(image, "W:red.bmp");
image.setPosition(8, 8);
const button = runtime.createButton(screen);
button.setSize(140, 60);
button.setPosition(90, 80);
const label = runtime.createLabel(button);
runtime.setText(label, "Click me");
button.on(runtime.clickedEvent, () => runtime.setText(label, "Clicked"));

const render = (elapsedMs: number) => {
  const result = runtime.step(elapsedMs);
  if (result.framesChanged) {
    const frame = runtime.readFrame(display);
    context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
  }
};

let last = performance.now();
const tick = (now: number) => {
  render(Math.min(1000, Math.max(0, Math.round(now - last))));
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const point = (event: PointerEvent) => {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.round((event.clientX - rect.left) * canvas.width / rect.width),
    y: Math.round((event.clientY - rect.top) * canvas.height / rect.height) };
};
canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  const position = point(event);
  pointer.push(position.x, position.y, true);
});
canvas.addEventListener("pointermove", (event) => {
  const position = point(event);
  pointer.push(position.x, position.y, event.buttons !== 0);
});
canvas.addEventListener("pointerup", (event) => {
  const position = point(event);
  pointer.push(position.x, position.y, false);
});
