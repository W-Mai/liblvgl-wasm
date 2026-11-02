import { exercise } from "./consumer.ts";

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<{ core: ArrayBuffer; wasi: ArrayBuffer }>) => {
  try {
    const result = await exercise(event.data.core, event.data.wasi);
    scope.postMessage({ result, hasSubtle: Boolean(globalThis.crypto?.subtle) });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
