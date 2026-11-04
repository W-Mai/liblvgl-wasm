import { expect, test } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { chainFixture, exerciseChain } from "../tests/fixtures/feature-sdk/chain.ts";

const captured: WebAssembly.Instance[] = [];
const property = Object.getOwnPropertyDescriptor(WebAssembly, "Instance")!;
const OriginalInstance = WebAssembly.Instance;
const proxy = new Proxy(OriginalInstance, {
  construct(target, args) {
    const instance = Reflect.construct(target, args, target) as WebAssembly.Instance;
    captured.push(instance);
    return instance;
  },
});
let load: typeof import("../target/validator/feature-validator.js").loadNumericEnvironment;
try {
  Object.defineProperty(WebAssembly, "Instance", { ...property, value: proxy });
  ({ loadNumericEnvironment: load } = await import("../target/validator/feature-validator.js?lvgl-chain-test"));
} finally {
  Object.defineProperty(WebAssembly, "Instance", property);
}

async function graph() {
  const path = Bun.env.LVW_TEST_CHAIN_GRAPH;
  if (!path) throw new Error("LVW_TEST_CHAIN_GRAPH is required");
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

test("three independent C modules use the same verified core in isolated environments", async () => {
  captured.length = 0;
  const bytes = await graph();
  const { input } = chainFixture(bytes);
  expect(input.modules.map(({ manifest }) => manifest.id)).toEqual(["app", "middle", "lvcore"]);
  const core = input.modules.find(({ manifest }) => manifest.id === "lvcore")!;
  const coreBytes = await Bun.file("target/wasm/liblvgl-bounded.wasm").bytes();
  const apiBytes = await Bun.file("target/wasm/api.json").bytes();
  const proof = await Bun.file("target/wasm/api-verification-bounded.json").json();
  const hash = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
  expect(core.bytes).toEqual(coreBytes);
  expect(proof.wasm_sha256).toBe(hash(coreBytes));
  expect(proof.api_sha256).toBe(hash(apiBytes));
  for (const item of input.modules) expect(inspectWasmFacts(item.bytes).sha256).toBe(item.manifest.artifact.sha256);
  const result = await exerciseChain(bytes.buffer, load);
  expect(result.values).toEqual([115, 117, 225, 227]);
  expect(result.traces).toEqual([[10, 20, 21, 11], [10, 20, 21, 11]]);
  expect(result.states).toEqual(["closed", "closed"]);
  expect(captured).toHaveLength(6);
  const memories = captured.map((item) => item.exports.memory);
  expect(memories.every((memory) => memory instanceof WebAssembly.Memory)).toBe(true);
  expect(new Set(memories).size).toBe(6);
  const cores = captured.filter((item) => typeof item.exports.lv_is_initialized === "function");
  expect(cores).toHaveLength(2);
  for (const instance of cores) expect((instance.exports.lv_is_initialized as () => number)()).toBe(0);
}, 300_000);

test("initialization failures roll back initialized providers and traps poison without guest cleanup", async () => {
  const bytes = await graph();
  for (const [name, expected] of [["middle-fail-init", [10]], ["app-fail-init", [10, 20, 11]]] as const) {
    captured.length = 0;
    const { input, options, traces } = chainFixture(bytes, name);
    await expect(load(input, options)).rejects.toThrow("module_init returned 7");
    expect([...traces.values()]).toEqual([expected]);
    const core = captured.find((item) => typeof item.exports.lv_is_initialized === "function")!;
    expect((core.exports.lv_is_initialized as () => number)()).toBe(0);
  }
  captured.length = 0;
  const { input, options, traces } = chainFixture(bytes);
  const environment = await load(input, options);
  expect(captured).toHaveLength(3);
  const core = captured.find((item) => typeof item.exports.lv_is_initialized === "function")!;
  expect((core.exports.lv_is_initialized as () => number)()).toBe(1);
  let failure: unknown;
  try { environment.run(-1); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
  expect((failure as Error).message.toLowerCase()).toContain("unreachable");
  expect(environment.state).toBe("poisoned");
  expect([...traces.values()]).toEqual([[10, 20]]);
  let next: unknown, close: unknown;
  try { environment.run(0); } catch (error) { next = error; }
  try { environment.close(); } catch (error) { close = error; }
  expect(next).toBe(failure);
  expect(close).toBe(failure);
  expect([...traces.values()]).toEqual([[10, 20]]);
  expect((core.exports.lv_is_initialized as () => number)()).toBe(1);
}, 300_000);

test("identity, interface, feature and resource mismatches reject before host creation", async () => {
  const bytes = await graph();
  for (const change of ["identity", "interface", "signature", "feature", "dependency", "limits"] as const) {
    const { input, options } = chainFixture(bytes);
    let created = 0;
    const hosts = options.hosts.map((host) => ({ ...host, create: (...args: Parameters<typeof host.create>) => {
      created++; return host.create(...args);
    } }));
    if (change === "identity") (input.modules.find(({ manifest }) => manifest.id === "middle")!.manifest.artifact as any).sha256 = "0".repeat(64);
    if (change === "interface") (input.modules.find(({ manifest }) => manifest.id === "app")!.manifest.requires.find((item) => item.provider === "middle") as any).version++;
    if (change === "signature") (input.modules.find(({ manifest }) => manifest.id === "app")!.manifest.requires.find((item) => item.provider === "middle")!.imports.find((item) => item.name === "middle_step") as any).params = [];
    if (change === "feature") (input.modules.find(({ manifest }) => manifest.id === "middle")!.manifest.target as any).features = ["simd"];
    if (change === "dependency") {
      const manifest = input.modules.find(({ manifest }) => manifest.id === "app")!.manifest;
      (manifest as any).requires = manifest.requires.filter((item) => item.provider !== "middle");
    }
    const limited = change === "limits" ? { ...options, maxTotalMemoryPages: 1 } : options;
    const errors = {
      identity: '"middle": artifact SHA-256 mismatch',
      interface: '"app" -> "middle": interface mismatch',
      signature: '"app" import "middle"."middle_step": artifact import has no matching declaration',
      feature: '"middle": feature inspection failed: FeatureValidationError: declared feature is not allowed by the host',
      dependency: '"app" import "middle"."middle_active": artifact import has no matching declaration',
      limits: "numeric environment resource limit exceeded",
    };
    await expect(load(input, { ...limited, hosts })).rejects.toThrow(errors[change]);
    expect(created).toBe(0);
  }
}, 300_000);
