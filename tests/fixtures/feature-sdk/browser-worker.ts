import { exercise } from "./consumer.ts";

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<{ core: ArrayBuffer; wasi: ArrayBuffer; lvProvider: ArrayBuffer; lvApp: ArrayBuffer }>) => {
  try {
    const result = await exercise(event.data.core, event.data.wasi, event.data.lvProvider, event.data.lvApp);
    scope.postMessage({ result, hasSubtle: Boolean(globalThis.crypto?.subtle) });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
