import { inspectWasmFacts } from "../../../bindings/typescript/src/wasm-facts.ts";
import { inspectWasiFacts, WASI_PREVIEW1_IMPORT_NAMES } from "../../../bindings/typescript/src/wasi-preview1.ts";

const [input, output, mode] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: bun real.ts INPUT.wasm OUTPUT.json [sdk45]");
const facts = inspectWasmFacts(await Bun.file(input).arrayBuffer());
const report = inspectWasiFacts(facts);
if (mode === "sdk45") {
  const expected = WASI_PREVIEW1_IMPORT_NAMES.filter((name) => name !== "proc_raise");
  if (report.imports.length !== 45 || new Set(report.imports).size !== 45 || expected.some((name) => !report.imports.includes(name))) {
    throw new Error("SDK fixture does not import all 45 expected functions");
  }
}
await Bun.write(output, JSON.stringify({ sha256: facts.sha256, ...report }));
