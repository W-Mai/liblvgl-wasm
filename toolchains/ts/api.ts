import type { Display, LvglRuntime, ObjectRef } from "../../bindings/typescript/src/index.ts";

export interface AppApi {
  runtime: LvglRuntime;
  display: Display;
  screen: ObjectRef;
  log(message: unknown): void;
}
