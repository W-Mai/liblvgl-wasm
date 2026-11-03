import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";
import { inspectIsolatedFacts } from "../../../bindings/typescript/src/isolated-resources.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: bun real.ts INPUT.wasm OUTPUT.json");
const facts = inspectWasmFacts(await Bun.file(input).arrayBuffer());
let report: object;
try {
  report = { sha256: facts.sha256, accepted: true, ...inspectIsolatedFacts(facts) };
} catch (error) {
  const message = String(error);
  const reasons = ["start section", "cannot import memory", "cannot import table", "mutable or reference", "reference-typed", "multiple memories", "multiple tables", "shared memory", "export its own memory"];
  const reason = reasons.find((part) => message.includes(part));
  if (!reason) throw error;
  report = { sha256: facts.sha256, accepted: false, reason };
}
await Bun.write(output, JSON.stringify(report));
