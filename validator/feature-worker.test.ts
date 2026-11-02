import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FeatureValidationError, validateWasmFeatures } from "../target/validator/feature-validator.js";
import type { FeatureValidationOptions } from "../bindings/typescript/src/feature-validator.ts";

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const originalWorker = globalThis.Worker;
type Mode = "success" | "reject" | "startup-timeout" | "execution-timeout" | "late-ready" | "late-result" | "reserve-failed" | "error" | "messageerror" | "invalid-message" | "throw";
let mode: Mode = "success";
let created: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(_url: string | URL) {
    if (mode === "throw") throw new Error("unavailable");
    created.push(this);
    const selected = mode;
    queueMicrotask(() => {
      if (selected === "startup-timeout") return;
      if (selected === "late-ready") {
        const end = performance.now() + 10;
        while (performance.now() < end) { /* Delay the event loop beyond the deadline. */ }
      }
      if (selected === "error") return this.onerror?.({ preventDefault() {} } as ErrorEvent);
      if (selected === "messageerror") return this.onmessageerror?.();
      if (selected === "invalid-message") return this.onmessage?.({ data: { type: "invalid" } } as MessageEvent);
      this.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    });
  }
  postMessage(data: { bytes: ArrayBuffer; mask: number }): void {
    const selected = mode;
    if (selected === "execution-timeout") return;
    queueMicrotask(() => {
      if (selected === "reserve-failed") return this.onmessage?.({ data: { type: "failure", code: "reserve-failed" } } as MessageEvent);
      if (selected === "late-result") {
        const end = performance.now() + 10;
        while (performance.now() < end) { /* Delay the event loop beyond the deadline. */ }
      }
      const inputSha256 = createHash("sha256").update(new Uint8Array(data.bytes)).digest("hex");
      this.onmessage?.({ data: { type: "result", accepted: selected !== "reject", inputSha256 } } as MessageEvent);
    });
  }
  terminate(): void { this.terminated = true; }
}

const options = (overrides: Partial<FeatureValidationOptions> = {}): FeatureValidationOptions => ({
  declaredFeatures: [], allowedFeatures: [], startupTimeoutMs: 1000, executionTimeoutMs: 1000, ...overrides,
});
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; throw new Error("expected rejection"); }
  catch (error) { if (!(error instanceof FeatureValidationError)) throw error; return error.code; }
};

beforeEach(() => {
  mode = "success";
  created = [];
  Object.defineProperty(globalThis, "Worker", { value: FakeWorker, configurable: true, writable: true });
});
afterEach(() => Object.defineProperty(globalThis, "Worker", { value: originalWorker, configurable: true, writable: true }));

test("host policy rejects unknown, duplicate and disallowed declarations", async () => {
  expect(await code(validateWasmFeatures(empty, options({ declaredFeatures: ["unknown"] })))).toBe("policy");
  expect(await code(validateWasmFeatures(empty, options({ declaredFeatures: ["simd", "simd"], allowedFeatures: ["simd"] })))).toBe("policy");
  expect(await code(validateWasmFeatures(empty, options({ declaredFeatures: ["simd"] })))).toBe("policy");
  expect(await code(validateWasmFeatures(empty, options({ allowedFeatures: ["simd", "simd"] })))).toBe("policy");
  expect(await code(validateWasmFeatures(empty, options({ executionTimeoutMs: Infinity })))).toBe("policy");
  expect(created).toHaveLength(0);
});

test("validation transfers a copy of the snapshot and releases the worker", async () => {
  const input = empty.slice();
  const expected = createHash("sha256").update(input).digest("hex");
  const result = validateWasmFeatures(input, options({ declaredFeatures: ["simd"], allowedFeatures: ["simd"] }));
  input.fill(0xff);
  expect((await result).inputSha256).toBe(expected);
  expect(created).toHaveLength(1);
  expect(created[0]!.terminated).toBe(true);
});

test("startup, execution, and late-message deadlines fail closed", async () => {
  mode = "startup-timeout";
  expect(await code(validateWasmFeatures(empty, options({ startupTimeoutMs: 5 })))).toBe("timeout");
  expect(created[0]!.terminated).toBe(true);
  mode = "execution-timeout";
  expect(await code(validateWasmFeatures(empty, options({ executionTimeoutMs: 5 })))).toBe("timeout");
  expect(created[1]!.terminated).toBe(true);
  mode = "late-ready";
  expect(await code(validateWasmFeatures(empty, options({ startupTimeoutMs: 1 })))).toBe("timeout");
  expect(created[2]!.terminated).toBe(true);
  mode = "late-result";
  expect(await code(validateWasmFeatures(empty, options({ executionTimeoutMs: 1 })))).toBe("timeout");
  expect(created[3]!.terminated).toBe(true);
});

test("worker failures, cancellation, and the concurrency limit release slots", async () => {
  mode = "reserve-failed";
  expect(await code(validateWasmFeatures(empty, options()))).toBe("reserve-failed");
  mode = "error";
  expect(await code(validateWasmFeatures(empty, options()))).toBe("helper-failed");
  mode = "messageerror";
  expect(await code(validateWasmFeatures(empty, options()))).toBe("helper-failed");
  mode = "invalid-message";
  expect(await code(validateWasmFeatures(empty, options()))).toBe("helper-failed");
  mode = "reject";
  expect(await code(validateWasmFeatures(empty, options()))).toBe("module-rejected");
  mode = "throw";
  expect(await code(validateWasmFeatures(empty, options()))).toBe("worker-unavailable");
  mode = "startup-timeout";
  const first = new AbortController(), second = new AbortController();
  const a = code(validateWasmFeatures(empty, options({ signal: first.signal })));
  const b = code(validateWasmFeatures(empty, options({ signal: second.signal })));
  expect(await code(validateWasmFeatures(empty, options()))).toBe("busy");
  first.abort(); second.abort();
  expect(await a).toBe("aborted");
  expect(await b).toBe("aborted");
  expect(created.every((worker) => worker.terminated)).toBe(true);
  mode = "success";
  expect((await validateWasmFeatures(empty, options())).status).toBe("passed");
});

test("invalid and shadowed abort signals cannot leak worker capacity", async () => {
  const invalid = { aborted: false } as unknown as AbortSignal;
  expect(await code(validateWasmFeatures(empty, options({ signal: invalid })))).toBe("invalid-input");
  expect(await code(validateWasmFeatures(empty, options({ signal: invalid })))).toBe("invalid-input");
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "addEventListener", { value: () => { throw new Error("shadowed add"); } });
  Object.defineProperty(controller.signal, "removeEventListener", { value: () => { throw new Error("shadowed remove"); } });
  mode = "startup-timeout";
  const pending = code(validateWasmFeatures(empty, options({ signal: controller.signal })));
  controller.abort();
  expect(await pending).toBe("aborted");
  expect(created[0]!.terminated).toBe(true);
  mode = "success";
  expect((await validateWasmFeatures(empty, options())).status).toBe("passed");
  expect((await validateWasmFeatures(empty, options())).status).toBe("passed");
});
