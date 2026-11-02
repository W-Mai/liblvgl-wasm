import { exercise } from "./consumer.ts";

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = await exercise(event.data);
    scope.postMessage({ result, hasSubtle: Boolean(globalThis.crypto?.subtle) });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
