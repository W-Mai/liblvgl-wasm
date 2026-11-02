import { sha256 } from "@noble/hashes/sha2.js";

export type WasmValueType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref";
export type WasmReferenceType = "funcref" | "externref";
export interface WasmFunctionType { readonly params: readonly WasmValueType[]; readonly results: readonly WasmValueType[] }
export interface WasmTableType { readonly element: WasmReferenceType; readonly minimum: number; readonly maximum: number | null }
export interface WasmMemoryType { readonly minimumPages: number; readonly maximumPages: number | null; readonly shared: boolean }
export interface WasmGlobalType { readonly value: WasmValueType; readonly mutable: boolean }
export type WasmExternal =
  | { readonly kind: "function"; readonly index: number; readonly typeIndex: number }
  | { readonly kind: "table"; readonly index: number; readonly type: WasmTableType }
  | { readonly kind: "memory"; readonly index: number; readonly type: WasmMemoryType }
  | { readonly kind: "global"; readonly index: number; readonly type: WasmGlobalType }
  | { readonly kind: "tag"; readonly index: number; readonly typeIndex: number };
export type WasmImportFact = { readonly module: string; readonly name: string } & WasmExternal;
export type WasmExportFact = { readonly name: string } & WasmExternal;
export interface WasmIndexedType<T> { readonly index: number; readonly imported: boolean; readonly type: T }
export interface WasmIndexedFunction { readonly index: number; readonly imported: boolean; readonly typeIndex: number }
export interface WasmFacts {
  readonly sha256: string;
  readonly types: readonly WasmFunctionType[];
  readonly imports: readonly WasmImportFact[];
  readonly exports: readonly WasmExportFact[];
  readonly functions: readonly WasmIndexedFunction[];
  readonly tables: readonly WasmIndexedType<WasmTableType>[];
  readonly memories: readonly WasmIndexedType<WasmMemoryType>[];
  readonly globals: readonly WasmIndexedType<WasmGlobalType>[];
  readonly tags: readonly WasmIndexedFunction[];
  readonly start: { readonly index: number; readonly typeIndex: number } | null;
  readonly validation: "not-run";
  readonly featureDetection: "not-run";
  readonly abiDetection: "not-run";
}

const values = new Map<number, WasmValueType>([
  [0x7f, "i32"], [0x7e, "i64"], [0x7d, "f32"], [0x7c, "f64"],
  [0x7b, "v128"], [0x70, "funcref"], [0x6f, "externref"],
]);
const sectionOrder = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [13, 6], [6, 7], [7, 8], [8, 9], [9, 10], [12, 11], [10, 12], [11, 13]]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const WASM_FACTS_LIMITS = Object.freeze({ inputBytes: 64 * 1024 * 1024, vectorElements: 50_000, nameBytes: 4 * 1024 * 1024, sections: 4_096 });
interface Budget { elements: number; names: number }
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getter = (prototype: object, name: string): ((this: unknown) => unknown) => Object.getOwnPropertyDescriptor(prototype, name)!.get!;
const bufferByteLength = getter(ArrayBuffer.prototype, "byteLength");
const typedBuffer = getter(typedArrayPrototype, "buffer");
const typedOffset = getter(typedArrayPrototype, "byteOffset");
const typedLength = getter(typedArrayPrototype, "byteLength");
const dataBuffer = getter(DataView.prototype, "buffer");
const dataOffset = getter(DataView.prototype, "byteOffset");
const dataLength = getter(DataView.prototype, "byteLength");

function byteView(input: BufferSource): Uint8Array {
  if (!ArrayBuffer.isView(input)) {
    bufferByteLength.call(input);
    return new Uint8Array(input);
  }
  let buffer: ArrayBufferLike, offset: number, length: number;
  try {
    buffer = dataBuffer.call(input) as ArrayBufferLike;
    offset = dataOffset.call(input) as number;
    length = dataLength.call(input) as number;
  } catch {
    buffer = typedBuffer.call(input) as ArrayBufferLike;
    offset = typedOffset.call(input) as number;
    length = typedLength.call(input) as number;
  }
  return new Uint8Array(buffer, offset, length);
}

class Reader {
  private position = 0;
  constructor(private readonly bytes: Uint8Array, private readonly context: string, private readonly budget: Budget) {}
  get remaining(): number { return this.bytes.length - this.position; }
  take(count: number): Uint8Array {
    if (count > this.remaining) throw new Error(`${this.context}: truncated input`);
    const result = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return result;
  }
  byte(): number { return this.take(1)[0]!; }
  u32(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      if (i === 4 && (byte & 0xf0) !== 0) throw new Error(`${this.context}: invalid u32 LEB`);
      value += (byte & 0x7f) * 2 ** (7 * i);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error(`${this.context}: invalid u32 LEB`);
  }
  signed(bits: 32 | 64): void {
    const limit = bits === 32 ? 5 : 10;
    for (let i = 0; i < limit; i++) {
      const byte = this.byte();
      if (i === limit - 1) {
        const sign = bits === 32 ? 0x08 : 0x01;
        const padding = bits === 32 ? 0x70 : 0x7e;
        if ((byte & 0x80) || (byte & padding) !== ((byte & sign) ? padding : 0)) {
          throw new Error(`${this.context}: invalid i${bits} LEB`);
        }
      }
      if ((byte & 0x80) === 0) return;
    }
    throw new Error(`${this.context}: invalid i${bits} LEB`);
  }
  name(): string {
    const length = this.u32();
    if (length > this.remaining) throw new Error(`${this.context}: truncated input`);
    if (length > WASM_FACTS_LIMITS.nameBytes - this.budget.names) throw new Error("Wasm facts inspection limit: name bytes");
    this.budget.names += length;
    const bytes = this.take(length);
    try { return utf8.decode(bytes); } catch { throw new Error(`${this.context}: invalid UTF-8 name`); }
  }
  vector<T>(read: () => T): T[] {
    const count = this.u32();
    if (count > this.remaining) throw new Error(`${this.context}: truncated vector`);
    if (count > WASM_FACTS_LIMITS.vectorElements - this.budget.elements) throw new Error("Wasm facts inspection limit: vector elements");
    this.budget.elements += count;
    const result: T[] = [];
    for (let i = 0; i < count; i++) result.push(read());
    return result;
  }
  finish(): void { if (this.remaining !== 0) throw new Error(`${this.context}: unexpected trailing bytes`); }
}

function valueType(reader: Reader): WasmValueType {
  const byte = reader.byte();
  const value = values.get(byte);
  if (!value) throw new Error(`unsupported value type 0x${byte.toString(16)}`);
  return value;
}

function referenceType(reader: Reader): WasmReferenceType {
  const value = valueType(reader);
  if (value !== "funcref" && value !== "externref") throw new Error(`unsupported table or heap type ${value}`);
  return value;
}

function tableType(reader: Reader): WasmTableType {
  const element = referenceType(reader);
  const flags = reader.byte();
  if (flags !== 0 && flags !== 1) throw new Error(`unsupported table limits flags ${flags}`);
  const minimum = reader.u32();
  const maximum = flags === 1 ? reader.u32() : null;
  if (maximum !== null && maximum < minimum) throw new Error("table maximum is smaller than minimum");
  return { element, minimum, maximum };
}

function memoryType(reader: Reader): WasmMemoryType {
  const flags = reader.byte();
  if (flags !== 0 && flags !== 1 && flags !== 3) throw new Error(`unsupported memory limits flags ${flags}`);
  const minimumPages = reader.u32();
  const maximumPages = flags & 1 ? reader.u32() : null;
  if (maximumPages !== null && maximumPages < minimumPages) throw new Error("memory maximum is smaller than minimum");
  if (minimumPages > 65536 || (maximumPages !== null && maximumPages > 65536)) throw new Error("memory limits exceed wasm32");
  return { minimumPages, maximumPages, shared: Boolean(flags & 2) };
}

function globalType(reader: Reader): WasmGlobalType {
  const value = valueType(reader);
  const mutable = reader.byte();
  if (mutable !== 0 && mutable !== 1) throw new Error("invalid global mutability");
  return { value, mutable: mutable === 1 };
}

function initializer(reader: Reader): void {
  const opcode = reader.byte();
  switch (opcode) {
    case 0x41: reader.signed(32); break;
    case 0x42: reader.signed(64); break;
    case 0x43: reader.take(4); break;
    case 0x44: reader.take(8); break;
    case 0x23: case 0xd2: reader.u32(); break;
    case 0xd0: referenceType(reader); break;
    default: throw new Error(`unsupported global initializer opcode 0x${opcode.toString(16)}`);
  }
  if (reader.byte() !== 0x0b) throw new Error("unsupported global initializer expression");
}

function at<T>(items: readonly T[], index: number, kind: string): T {
  if (index >= items.length) throw new Error(`${kind} index ${index} is out of bounds`);
  return items[index]!;
}

function tagType(reader: Reader, types: readonly WasmFunctionType[]): number {
  if (reader.byte() !== 0) throw new Error("unsupported tag attribute");
  const index = reader.u32(), type = at(types, index, "tag type");
  if (type.results.length) throw new Error("tag type must not have results");
  return index;
}

/** Read supported declaration sections from a private byte snapshot. This is not complete Wasm validation or feature or ABI detection. */
export function inspectWasmFacts(input: BufferSource): WasmFacts {
  const source = byteView(input);
  const length = typedLength.call(source) as number;
  if (length > WASM_FACTS_LIMITS.inputBytes) throw new Error("Wasm facts inspection limit: input bytes");
  const snapshot = new Uint8Array(length);
  snapshot.set(source);
  const hash = Array.from(sha256(snapshot), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const budget: Budget = { elements: 0, names: 0 };
  const module = new Reader(snapshot, "module", budget);
  if (!module.take(8).every((byte, index) => byte === [0, 97, 115, 109, 1, 0, 0, 0][index])) {
    throw new Error("expected a core Wasm version 1 module");
  }
  const types: WasmFunctionType[] = [];
  const functions: number[] = [];
  const tables: WasmTableType[] = [];
  const memories: WasmMemoryType[] = [];
  const globals: WasmGlobalType[] = [];
  const tags: number[] = [];
  const imports: WasmImportFact[] = [];
  const exports: WasmExportFact[] = [];
  const imported = { function: 0, table: 0, memory: 0, global: 0, tag: 0 };
  const exportNames = new Set<string>();
  let start: WasmFacts["start"] = null;
  let previous = 0;
  let sectionCount = 0;
  while (module.remaining) {
    if (++sectionCount > WASM_FACTS_LIMITS.sections) throw new Error("Wasm facts inspection limit: sections");
    const id = module.byte();
    const reader = new Reader(module.take(module.u32()), `section ${id}`, budget);
    if (id === 0) { reader.name(); continue; }
    const order = sectionOrder.get(id);
    if (order === undefined) throw new Error(`unsupported section ${id}`);
    if (order <= previous) throw new Error(`duplicate or out-of-order section ${id}`);
    previous = order;
    switch (id) {
      case 1:
        for (const type of reader.vector(() => {
          if (reader.byte() !== 0x60) throw new Error("unsupported type definition");
          return { params: reader.vector(() => valueType(reader)), results: reader.vector(() => valueType(reader)) };
        })) types.push(type);
        break;
      case 2:
        reader.vector(() => {
          const moduleName = reader.name(), name = reader.name(), kind = reader.byte();
          let item: WasmExternal;
          if (kind === 0) {
            const typeIndex = reader.u32();
            at(types, typeIndex, "type");
            item = { kind: "function", index: functions.length, typeIndex }; functions.push(typeIndex);
          } else if (kind === 1) {
            const type = tableType(reader);
            item = { kind: "table", index: tables.length, type }; tables.push(type);
          } else if (kind === 2) {
            const type = memoryType(reader);
            item = { kind: "memory", index: memories.length, type }; memories.push(type);
          } else if (kind === 3) {
            const type = globalType(reader);
            item = { kind: "global", index: globals.length, type }; globals.push(type);
          } else if (kind === 4) {
            const typeIndex = tagType(reader, types);
            item = { kind: "tag", index: tags.length, typeIndex }; tags.push(typeIndex);
          } else throw new Error(`unsupported import kind ${kind}`);
          imported[item.kind]++;
          imports.push({ module: moduleName, name, ...item });
        });
        break;
      case 3: for (const typeIndex of reader.vector(() => { const index = reader.u32(); at(types, index, "type"); return index; })) functions.push(typeIndex); break;
      case 4: for (const type of reader.vector(() => tableType(reader))) tables.push(type); break;
      case 5: for (const type of reader.vector(() => memoryType(reader))) memories.push(type); break;
      case 13: for (const typeIndex of reader.vector(() => tagType(reader, types))) tags.push(typeIndex); break;
      case 6: for (const type of reader.vector(() => { const type = globalType(reader); initializer(reader); return type; })) globals.push(type); break;
      case 7:
        reader.vector(() => {
          const name = reader.name(), kind = reader.byte(), index = reader.u32();
          if (exportNames.has(name)) throw new Error(`duplicate export ${JSON.stringify(name)}`);
          exportNames.add(name);
          let item: WasmExternal;
          if (kind === 0) item = { kind: "function", index, typeIndex: at(functions, index, "function") };
          else if (kind === 1) item = { kind: "table", index, type: at(tables, index, "table") };
          else if (kind === 2) item = { kind: "memory", index, type: at(memories, index, "memory") };
          else if (kind === 3) item = { kind: "global", index, type: at(globals, index, "global") };
          else if (kind === 4) item = { kind: "tag", index, typeIndex: at(tags, index, "tag") };
          else throw new Error(`unsupported export kind ${kind}`);
          exports.push({ name, ...item });
        });
        break;
      case 8: {
        const index = reader.u32(), typeIndex = at(functions, index, "start function"), type = at(types, typeIndex, "type");
        if (type.params.length || type.results.length) throw new Error("start function must have no parameters or results");
        start = { index, typeIndex };
        break;
      }
      case 12: reader.u32(); break;
      // Code, element and data payloads are intentionally opaque.
      case 9: case 10: case 11: continue;
    }
    reader.finish();
  }
  const indexed = <T>(items: readonly T[], importedCount: number): WasmIndexedType<T>[] =>
    items.map((type, index) => ({ index, imported: index < importedCount, type }));
  const indexedFunctions = (items: readonly number[], importedCount: number): WasmIndexedFunction[] =>
    items.map((typeIndex, index) => ({ index, imported: index < importedCount, typeIndex }));
  return { sha256: hash, types, imports, exports, start,
    functions: indexedFunctions(functions, imported.function), tables: indexed(tables, imported.table),
    memories: indexed(memories, imported.memory), globals: indexed(globals, imported.global), tags: indexedFunctions(tags, imported.tag),
    validation: "not-run", featureDetection: "not-run", abiDetection: "not-run" };
}
