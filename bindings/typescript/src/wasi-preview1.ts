import { inspectWasmSnapshot, snapshotWasmBytes, type WasmFunctionType, type WasmValueType } from "./wasm-facts.ts";

const WasmModule = WebAssembly.Module;

// i denotes i32 and I denotes i64. The two sides of / are parameters and results.
const signatures = new Map<string, string>([
  ["args_get", "ii/i"], ["args_sizes_get", "ii/i"],
  ["clock_res_get", "ii/i"], ["clock_time_get", "iIi/i"],
  ["environ_get", "ii/i"], ["environ_sizes_get", "ii/i"],
  ["fd_advise", "iIIi/i"], ["fd_allocate", "iII/i"], ["fd_close", "i/i"],
  ["fd_datasync", "i/i"], ["fd_fdstat_get", "ii/i"], ["fd_fdstat_set_flags", "ii/i"],
  ["fd_fdstat_set_rights", "iII/i"], ["fd_filestat_get", "ii/i"], ["fd_filestat_set_size", "iI/i"],
  ["fd_filestat_set_times", "iIIi/i"], ["fd_pread", "iiiIi/i"],
  ["fd_prestat_dir_name", "iii/i"], ["fd_prestat_get", "ii/i"], ["fd_pwrite", "iiiIi/i"],
  ["fd_read", "iiii/i"], ["fd_readdir", "iiiIi/i"], ["fd_renumber", "ii/i"],
  ["fd_seek", "iIii/i"], ["fd_sync", "i/i"], ["fd_tell", "ii/i"], ["fd_write", "iiii/i"],
  ["path_create_directory", "iii/i"], ["path_filestat_get", "iiiii/i"],
  ["path_filestat_set_times", "iiiiIIi/i"], ["path_link", "iiiiiii/i"],
  ["path_open", "iiiiiIIii/i"], ["path_readlink", "iiiiii/i"],
  ["path_remove_directory", "iii/i"], ["path_rename", "iiiiii/i"],
  ["path_symlink", "iiiii/i"], ["path_unlink_file", "iii/i"],
  ["poll_oneoff", "iiii/i"], ["proc_exit", "i/"], ["proc_raise", "i/i"],
  ["random_get", "ii/i"], ["sched_yield", "/i"], ["sock_accept", "iii/i"],
  ["sock_recv", "iiiiii/i"], ["sock_send", "iiiii/i"], ["sock_shutdown", "ii/i"],
]);

export const WASI_PREVIEW1_IMPORT_NAMES: readonly string[] = Object.freeze([...signatures.keys()]);

export interface WasiPreview1Report {
  readonly sha256: string;
  readonly evidence: "present" | "absent";
  readonly imports: readonly string[];
  readonly entrypoints: { readonly initialize: boolean; readonly start: boolean; readonly startSection: boolean };
  readonly checks: {
    readonly importSignatures: "passed" | "not-observed";
    readonly engine: "passed";
    readonly targetProvenance: "not-run";
    readonly feature: "not-run";
    readonly hostImplementation: "not-run";
    readonly runtime: "not-run";
  };
}

function encodeTypes(values: readonly WasmValueType[]): string {
  return values.map((value) => value === "i32" ? "i" : value === "i64" ? "I" : "?").join("");
}

function signature(type: WasmFunctionType): string {
  return `${encodeTypes(type.params)}/${encodeTypes(type.results)}`;
}

function formatSignature(value: string): string {
  const [params = "", results = ""] = value.split("/");
  const format = (part: string) => [...part].map((value) => value === "i" ? "i32" : value === "I" ? "i64" : "unsupported").join(", ");
  return `(${format(params)}) -> (${format(results)})`;
}

/** Check observed WASI Preview 1 import signatures without instantiating the module. */
export function inspectWasiPreview1(input: BufferSource): WasiPreview1Report {
  const snapshot = snapshotWasmBytes(input);
  const facts = inspectWasmSnapshot(snapshot);
  const imports: string[] = [];
  const signatureCache = new Map<number, string>();
  const typeSignature = (index: number): string => {
    let result = signatureCache.get(index);
    if (result === undefined) {
      result = signature(facts.types[index]!);
      signatureCache.set(index, result);
    }
    return result;
  };
  for (const item of facts.imports) {
    if (item.module === "wasi_unstable" || item.module.startsWith("wasi:")) {
      throw new Error(`unsupported WASI import namespace ${JSON.stringify(item.module)}`);
    }
    if (item.module !== "wasi_snapshot_preview1") continue;
    const expected = signatures.get(item.name);
    if (expected === undefined) throw new Error(`unsupported WASI Preview 1 import ${JSON.stringify(item.name)}`);
    if (item.kind !== "function") throw new Error(`WASI Preview 1 import ${JSON.stringify(item.name)} must be a function`);
    const type = facts.types[item.typeIndex]!;
    const actual = typeSignature(item.typeIndex);
    if (actual !== expected) {
      throw new Error(`WASI Preview 1 import ${JSON.stringify(item.name)} signature mismatch: expected ${formatSignature(expected)}, actual (${type.params.join(", ")}) -> (${type.results.join(", ")})`);
    }
    imports.push(item.name);
  }
  const entrypoints = { initialize: false, start: false, startSection: facts.start !== null };
  for (const item of facts.exports) {
    if (item.name !== "_initialize" && item.name !== "_start") continue;
    if (item.kind !== "function" || typeSignature(item.typeIndex) !== "/") {
      throw new Error(`WASI entrypoint ${JSON.stringify(item.name)} must be a () -> () function`);
    }
    if (item.name === "_initialize") entrypoints.initialize = true;
    else entrypoints.start = true;
  }
  try { new WasmModule(snapshot); } catch (error) { throw new Error(`current engine compilation failed: ${String(error)}`); }
  const evidence = imports.length ? "present" : "absent";
  return { sha256: facts.sha256, evidence, imports, entrypoints, checks: {
    importSignatures: evidence === "present" ? "passed" : "not-observed", engine: "passed",
    targetProvenance: "not-run", feature: "not-run", hostImplementation: "not-run", runtime: "not-run",
  } };
}
