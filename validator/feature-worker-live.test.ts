import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FeatureValidationError, validateWasmFeatures } from "../target/validator/feature-validator.js";

const features: readonly [string, readonly string[]][] = [
  ["bulk-memory", []], ["reference-types", []], ["sign-extension", []],
  ["saturating-float-to-int", []], ["exceptions", []], ["simd", []],
  ["multi-value", []], ["threads", []], ["memory64", []], ["multi-memory", []],
  ["tail-call", []], ["extended-const", []], ["relaxed-simd", ["simd"]],
  ["legacy-exceptions", []], ["function-references", ["reference-types"]],
  ["gc", ["reference-types", "function-references"]],
];

test("private worker enforces generated feature policies against actual modules", async () => {
  for (const [name, dependencies] of features) {
    const input = await Bun.file(`target/validator/fixtures/${name}.wasm`).bytes();
    const allowedFeatures = [...dependencies, name];
    const options = { allowedFeatures, startupTimeoutMs: 10_000, executionTimeoutMs: 10_000 };
    try {
      await validateWasmFeatures(input, { ...options, declaredFeatures: dependencies });
      throw new Error(`${name} was accepted without its feature`);
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureValidationError);
      expect((error as InstanceType<typeof FeatureValidationError>).code).toBe("module-rejected");
    }
    const report = await validateWasmFeatures(input, { ...options, declaredFeatures: allowedFeatures });
    expect(report.inputSha256).toBe(createHash("sha256").update(input).digest("hex"));
    expect(report.declaredFeatures).toEqual(allowedFeatures);
    expect(report.status).toBe("passed");
    expect(report.checks).toEqual({ engine: "not-run", wasiAbi: "not-run", resourceTopology: "not-run", runtime: "not-run" });
  }
}, 120_000);
