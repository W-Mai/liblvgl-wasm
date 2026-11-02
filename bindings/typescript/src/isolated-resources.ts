import { inspectWasmSnapshot, snapshotWasmBytes, type WasmExternal, type WasmFacts, type WasmValueType } from "./wasm-facts.ts";

const WasmModule = WebAssembly.Module;

export interface IsolatedResourceReport {
  readonly sha256: string;
  readonly memories: number;
  readonly tables: number;
  readonly usesWasi: boolean;
  readonly checks: {
    readonly resourceTopology: "passed";
    readonly engine: "passed";
    readonly feature: "not-run";
    readonly wasiAbi: "not-run";
    readonly pointerContracts: "not-run";
    readonly handleIsolation: "not-run";
    readonly environmentIsolation: "not-run";
    readonly hostImplementation: "not-run";
    readonly lifecycle: "not-run";
  };
}

const isReference = (value: WasmValueType): boolean => value === "funcref" || value === "externref";

function checkInterface(facts: WasmFacts, item: WasmExternal, label: string, references: Map<number, boolean>): void {
  if (item.kind !== "function" && item.kind !== "tag") return;
  let hasReference = references.get(item.typeIndex);
  if (hasReference === undefined) {
    const signature = facts.types[item.typeIndex]!;
    hasReference = signature.params.some(isReference) || signature.results.some(isReference);
    references.set(item.typeIndex, hasReference);
  }
  if (hasReference) {
    throw new Error(`${label}: reference-typed function or tag crosses an instance boundary`);
  }
}

/** Inspect an isolated module's resource topology without creating an instance. */
export function inspectIsolatedResources(input: BufferSource): IsolatedResourceReport {
  return inspectIsolatedSnapshot(snapshotWasmBytes(input));
}

/** @internal Inspect a snapshot owned by the caller for the entire synchronous call. */
export function inspectIsolatedSnapshot(snapshot: Uint8Array<ArrayBuffer>): IsolatedResourceReport {
  const facts = inspectWasmSnapshot(snapshot);
  const topology = inspectIsolatedFacts(facts);
  try { new WasmModule(snapshot); } catch (error) { throw new Error(`current engine compilation failed: ${String(error)}`); }
  return {
    sha256: facts.sha256,
    ...topology,
    checks: {
      resourceTopology: "passed", engine: "passed", feature: "not-run", wasiAbi: "not-run",
      pointerContracts: "not-run", handleIsolation: "not-run", environmentIsolation: "not-run",
      hostImplementation: "not-run", lifecycle: "not-run",
    },
  };
}

/** @internal Check topology against facts from a private snapshot. */
export function inspectIsolatedFacts(facts: WasmFacts): Pick<IsolatedResourceReport, "memories" | "tables" | "usesWasi"> {
  if (facts.start !== null) throw new Error("isolated module cannot have a start section");
  const references = new Map<number, boolean>();
  for (const item of facts.imports) {
    const label = `import ${JSON.stringify(item.module)}.${JSON.stringify(item.name)}`;
    if (item.kind === "memory" || item.kind === "table") throw new Error(`${label}: isolated module cannot import ${item.kind}`);
    if (item.kind === "global" && (item.type.mutable || isReference(item.type.value))) {
      throw new Error(`${label}: isolated module cannot import mutable or reference-typed globals`);
    }
    checkInterface(facts, item, label, references);
  }
  for (const item of facts.exports) checkInterface(facts, item, `export ${JSON.stringify(item.name)}`, references);
  if (facts.memories.length > 1) throw new Error("isolated module cannot have multiple memories");
  if (facts.tables.length > 1) throw new Error("isolated module cannot have multiple tables");
  if (facts.memories.some((memory) => memory.type.shared)) throw new Error("isolated module cannot have shared memory");
  const usesWasi = facts.imports.some((item) => item.module === "wasi_snapshot_preview1");
  if (usesWasi && (facts.memories.length !== 1 || !facts.exports.some((item) => item.kind === "memory" && item.name === "memory" && item.index === 0))) {
    throw new Error("isolated WASI module must export its own memory as memory");
  }
  return { memories: facts.memories.length, tables: facts.tables.length, usesWasi };
}
