import type { ModuleInterface } from "./module-manifest.ts";

export type NumericWasiService = "environ_get" | "environ_sizes_get" | "fd_close" | "fd_seek" | "fd_write" | "proc_exit" | "clock_time_get";

/** Explicit WASI Preview 1 permissions and bounded output for one environment. */
export interface NumericWasiOptions {
  readonly id: string;
  readonly interface: ModuleInterface;
  readonly allowed: readonly NumericWasiService[];
  readonly outputFds: readonly (1 | 2)[];
  readonly maxIovecs: number;
  readonly maxWriteBytes: number;
  readonly maxOutputBytes: number;
  readonly onWrite: (consumerId: string, fd: 1 | 2, bytes: Uint8Array<ArrayBuffer>, environmentId: symbol) => void;
  readonly clock?: { readonly realtimeNs: bigint; readonly monotonicNs: bigint };
}

/** A guest-requested WASI process exit. The environment cannot be resumed. */
export class NumericWasiExit extends Error {
  constructor(readonly code: number) {
    super(`WASI process exited with code ${code}`);
    this.name = "NumericWasiExit";
  }
}

export const NUMERIC_WASI_SIGNATURES: Readonly<Record<NumericWasiService, string>> = Object.freeze({
  environ_get: "ii/i", environ_sizes_get: "ii/i", fd_close: "i/i", fd_seek: "iIii/i",
  fd_write: "iiii/i", proc_exit: "i/", clock_time_get: "iIi/i",
});

const OK = 0, BADF = 8, FAULT = 21, INVAL = 28, NOSPC = 51, NOTSUP = 58, SPIPE = 70;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_IOVECS = 4096, MAX_WRITE = 16 * 1024 * 1024, MAX_OUTPUT = 64 * 1024 * 1024;

function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid numeric WASI options");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error("invalid numeric WASI options");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !required.includes(key) && !optional.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error("invalid numeric WASI options");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("invalid numeric WASI options");
    result[key] = descriptor.value;
  }
  return result;
}

function bounded(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("invalid numeric WASI limit");
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.trim() !== value) throw new Error("invalid numeric WASI identity");
  return value;
}

/** @internal Capture a plain, explicit permission set before asynchronous work. */
export function prepareNumericWasi(value: unknown): NumericWasiOptions {
  const item = data(value, ["id", "interface", "allowed", "outputFds", "maxIovecs", "maxWriteBytes", "maxOutputBytes", "onWrite"], ["clock"]);
  const iface = data(item.interface, ["name", "version"]);
  const version = bounded(iface.version, 0xffff_ffff);
  if (version === 0) throw new Error("invalid numeric WASI interface version");
  const input = item.allowed;
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 7 || Reflect.ownKeys(input).length !== input.length + 1) {
    throw new Error("invalid numeric WASI permissions");
  }
  const allowed: NumericWasiService[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    const service = descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
    if (typeof service !== "string" || !Object.hasOwn(NUMERIC_WASI_SIGNATURES, service) || allowed.includes(service as NumericWasiService)) {
      throw new Error("invalid numeric WASI permissions");
    }
    allowed.push(service as NumericWasiService);
  }
  const fds = item.outputFds;
  if (!Array.isArray(fds) || Object.getPrototypeOf(fds) !== Array.prototype || fds.length > 2 || Reflect.ownKeys(fds).length !== fds.length + 1) {
    throw new Error("invalid numeric WASI output permissions");
  }
  const outputFds: (1 | 2)[] = [];
  for (let index = 0; index < fds.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(fds, String(index));
    const fd = descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
    if ((fd !== 1 && fd !== 2) || outputFds.includes(fd)) throw new Error("invalid numeric WASI output permissions");
    outputFds.push(fd);
  }
  if (typeof item.onWrite !== "function") throw new Error("invalid numeric WASI output sink");
  let clock: NumericWasiOptions["clock"];
  if (item.clock !== undefined) {
    const source = data(item.clock, ["realtimeNs", "monotonicNs"]);
    if (typeof source.realtimeNs !== "bigint" || source.realtimeNs < 0n || source.realtimeNs > MAX_U64
        || typeof source.monotonicNs !== "bigint" || source.monotonicNs < 0n || source.monotonicNs > MAX_U64) {
      throw new Error("invalid numeric WASI clock");
    }
    clock = { realtimeNs: source.realtimeNs, monotonicNs: source.monotonicNs };
  }
  if (allowed.includes("clock_time_get") && !clock) throw new Error("numeric WASI clock requires an explicit value");
  return { id: identifier(item.id), interface: { name: identifier(iface.name), version }, allowed, outputFds,
    maxIovecs: bounded(item.maxIovecs, MAX_IOVECS), maxWriteBytes: bounded(item.maxWriteBytes, MAX_WRITE),
    maxOutputBytes: bounded(item.maxOutputBytes, MAX_OUTPUT), onWrite: item.onWrite as NumericWasiOptions["onWrite"], clock };
}

/** @internal An output quota is shared only by consumers of one environment. */
export function createNumericWasiBudget(): { output: number } { return { output: 0 }; }

/** @internal Bind one provider to one consumer's private linear memory. */
export function createNumericWasiConsumer(options: NumericWasiOptions, consumer: string, budget: { output: number }, assertActive: () => void,
  environmentId = Symbol("numeric WASI consumer")) {
  let memory: WebAssembly.Memory | undefined;
  let closed = false;
  const descriptors = [false, options.outputFds.includes(1), options.outputFds.includes(2)];
  const getBuffer = (): ArrayBuffer | undefined => {
    if (closed || !memory) return undefined;
    const buffer = memory.buffer;
    return buffer instanceof ArrayBuffer ? buffer : undefined;
  };
  const inBounds = (buffer: ArrayBuffer, pointer: number, length: number) => pointer <= buffer.byteLength && length <= buffer.byteLength - pointer;
  const exports = {
    environ_get(_environment: number, _buffer: number): number { return getBuffer() ? OK : FAULT; },
    environ_sizes_get(count: number, size: number): number {
      const buffer = getBuffer();
      count >>>= 0; size >>>= 0;
      if (!buffer || !inBounds(buffer, count, 4) || !inBounds(buffer, size, 4)) return FAULT;
      const view = new DataView(buffer);
      view.setUint32(count, 0, true); view.setUint32(size, 0, true);
      return OK;
    },
    fd_close(fd: number): number {
      fd >>>= 0;
      if (!getBuffer() || fd > 2 || !descriptors[fd]) return BADF;
      descriptors[fd] = false;
      return OK;
    },
    fd_seek(fd: number, _offset: bigint, _whence: number, _result: number): number {
      fd >>>= 0;
      return getBuffer() && fd <= 2 && descriptors[fd] ? SPIPE : BADF;
    },
    fd_write(fd: number, iovPointer: number, iovCount: number, writtenPointer: number): number {
      fd >>>= 0; iovPointer >>>= 0; iovCount >>>= 0; writtenPointer >>>= 0;
      const buffer = getBuffer();
      if (!buffer || (fd !== 1 && fd !== 2) || !descriptors[fd] || !options.outputFds.includes(fd)) return BADF;
      if (iovCount > options.maxIovecs) return INVAL;
      if (!inBounds(buffer, iovPointer, iovCount * 8) || !inBounds(buffer, writtenPointer, 4)) return FAULT;
      const view = new DataView(buffer), ranges: { pointer: number; length: number }[] = [];
      let total = 0;
      for (let index = 0; index < iovCount; index++) {
        const offset = iovPointer + index * 8;
        const pointer = view.getUint32(offset, true), length = view.getUint32(offset + 4, true);
        if (!inBounds(buffer, pointer, length)) return FAULT;
        total += length;
        if (total > options.maxWriteBytes || total > 0xffff_ffff) return INVAL;
        ranges.push({ pointer, length });
      }
      if (total > options.maxOutputBytes - budget.output) return NOSPC;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const range of ranges) { bytes.set(new Uint8Array(buffer, range.pointer, range.length), offset); offset += range.length; }
      if (total) {
        const result: unknown = options.onWrite(consumer, fd, bytes, environmentId);
        if (result !== undefined) {
          try { Promise.prototype.then.call(result, undefined, () => {}); } catch { /* Non-Promise values are rejected below. */ }
          throw new Error("numeric WASI output sink must return undefined");
        }
        assertActive();
      }
      view.setUint32(writtenPointer, total, true);
      budget.output += total;
      return OK;
    },
    proc_exit(code: number): never {
      if (!getBuffer()) throw new Error("numeric WASI consumer is unavailable");
      throw new NumericWasiExit(code >>> 0);
    },
    clock_time_get(clockId: number, _precision: bigint, pointer: number): number {
      clockId >>>= 0; pointer >>>= 0;
      if (clockId > 3) return INVAL;
      if (clockId > 1) return NOTSUP;
      const buffer = getBuffer();
      if (!buffer || !inBounds(buffer, pointer, 8)) return FAULT;
      if (!options.clock) throw new Error("numeric WASI clock is unavailable");
      new DataView(buffer).setBigUint64(pointer, clockId === 0 ? options.clock.realtimeNs : options.clock.monotonicNs, true);
      return OK;
    },
  };
  const permitted = Object.freeze(Object.fromEntries(options.allowed.map((name) => [name, exports[name]]))) as Readonly<Partial<typeof exports>>;
  return {
    exports: permitted,
    bind(value: WebAssembly.Memory): void {
      if (closed || memory || !(value instanceof WebAssembly.Memory) || !(value.buffer instanceof ArrayBuffer)) throw new Error("invalid numeric WASI memory binding");
      memory = value;
    },
    close(): void { closed = true; memory = undefined; descriptors.fill(false); },
  };
}
