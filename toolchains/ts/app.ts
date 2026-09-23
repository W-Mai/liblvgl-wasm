import type { LvglRuntime, ObjectRef, Display } from "../../bindings/typescript/src/index.ts";

interface StudioApi {
  runtime: LvglRuntime;
  display: Display;
  screen: ObjectRef;
  log(message: unknown): void;
}

function main(api: StudioApi): void {
  const button = api.runtime.createButton(api.screen);
  button.setSize(180, 64);
  button.setPosition(70, 88);
  const label = api.runtime.createLabel(button);
  api.runtime.setText(label, "TS application");
  button.on(api.runtime.clickedEvent, () => {
    api.runtime.setText(label, "TS clicked");
    api.log("TS clicked");
  });
}

(globalThis as typeof globalThis & { main?: (api: StudioApi) => void }).main = main;
