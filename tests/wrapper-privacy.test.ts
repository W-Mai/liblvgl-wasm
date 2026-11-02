import { expect, test } from "bun:test";
import { Animation } from "../bindings/typescript/src/animation.ts";
import { DecoderSession, ImageDecoder } from "../bindings/typescript/src/decoder.ts";
import { Display, ObjectRef, PointerInput, Timer } from "../bindings/typescript/src/index.ts";
import { Observer } from "../bindings/typescript/src/observer.ts";

test("managed wrappers do not expose their runtime or registry as object properties", () => {
  const runtime = { trackDisplay: () => () => {}, trackObject: () => () => {} } as never;
  const display = new Display(runtime, 1);
  const wrappers = [new Timer(runtime), display, new PointerInput(runtime, 1, display),
    new ObjectRef(runtime, 1), new Animation({} as never), new Observer({} as never),
    new ImageDecoder({} as never), new DecoderSession({} as never)];
  for (const wrapper of wrappers) {
    expect(Object.getOwnPropertyNames(wrapper)).not.toContain("runtime");
    expect(Object.getOwnPropertyNames(wrapper)).not.toContain("registry");
  }
});
