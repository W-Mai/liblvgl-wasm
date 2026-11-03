import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: bun reference.ts INPUT.wasm OUTPUT.json");
const facts = inspectWasmFacts(await Bun.file(input).arrayBuffer());
if (facts.validation !== "not-run" || facts.featureDetection !== "not-run" || facts.abiDetection !== "not-run") {
  throw new Error("unexpected Wasm facts check status");
}
await Bun.write(output, JSON.stringify(facts));
