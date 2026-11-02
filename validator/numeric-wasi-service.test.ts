import { expect, test } from "bun:test";
import { createNumericWasiBudget, createNumericWasiConsumer, NumericWasiExit, prepareNumericWasi } from "../bindings/typescript/src/numeric-wasi.ts";

function fixture() {
  const writes: { consumer: string; fd: number; bytes: Uint8Array }[] = [];
  const source = { id: "host.wasi", interface: { name: "wasi", version: 1 },
    allowed: ["environ_get", "environ_sizes_get", "fd_close", "fd_seek", "fd_write", "proc_exit", "clock_time_get"],
    outputFds: [1, 2], maxIovecs: 4, maxWriteBytes: 32, maxOutputBytes: 64,
    clock: { realtimeNs: 123n, monotonicNs: 456n },
    onWrite: (consumer: string, fd: 1 | 2, bytes: Uint8Array) => { writes.push({ consumer, fd, bytes }); } };
  return { source, options: prepareNumericWasi(source), writes };
}

function iov(memory: WebAssembly.Memory, entries: [number, number][], base = 0) {
  const view = new DataView(memory.buffer);
  for (let index = 0; index < entries.length; index++) {
    view.setUint32(base + index * 8, entries[index]![0], true);
    view.setUint32(base + index * 8 + 4, entries[index]![1], true);
  }
}

test("per-consumer memory and fd permissions use bounded output copies", () => {
  const { options, writes } = fixture();
  const budget = createNumericWasiBudget();
  const a = createNumericWasiConsumer(options, "a", budget, () => {});
  const b = createNumericWasiConsumer(options, "b", budget, () => {});
  const first = new WebAssembly.Memory({ initial: 1, maximum: 2 }), second = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  a.bind(first); b.bind(second);
  iov(first, [[100, 3], [200, 2]]); iov(second, [[100, 2]]);
  new Uint8Array(first.buffer).set([65, 66, 67], 100);
  new Uint8Array(first.buffer).set([68, 69], 200);
  new Uint8Array(second.buffer).set([88, 89], 100);
  expect(a.exports.fd_write!(1, 0, 2, 40)).toBe(0);
  expect(b.exports.fd_write!(2, 0, 1, 40)).toBe(0);
  expect(writes.map(({ consumer, fd, bytes }) => [consumer, fd, [...bytes]])).toEqual([["a", 1, [65, 66, 67, 68, 69]], ["b", 2, [88, 89]]]);
  expect(new DataView(first.buffer).getUint32(40, true)).toBe(5);
  expect(new DataView(second.buffer).getUint32(40, true)).toBe(2);
  new Uint8Array(first.buffer).fill(0, 100, 103);
  expect([...writes[0]!.bytes]).toEqual([65, 66, 67, 68, 69]);
  first.grow(1);
  iov(first, [[65540, 2]]);
  new Uint8Array(first.buffer).set([70, 71], 65540);
  expect(a.exports.fd_write!(1, 0, 1, 40)).toBe(0);
  expect([...writes[2]!.bytes]).toEqual([70, 71]);
  expect(budget.output).toBe(9);
  a.close(); b.close();
});

test("malformed iovecs and exhausted limits do not emit or write nwritten", () => {
  const { options, writes } = fixture();
  const budget = createNumericWasiBudget(), consumer = createNumericWasiConsumer(options, "a", budget, () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  consumer.bind(memory);
  const view = new DataView(memory.buffer);
  view.setUint32(40, 0xfeedface, true);
  iov(memory, [[100, 2], [65535, 2]]);
  expect(consumer.exports.fd_write!(1, 0, 2, 40)).toBe(21);
  expect(consumer.exports.fd_write!(1, 65532, 1, 40)).toBe(21);
  expect(consumer.exports.fd_write!(1, 0, -1, 40)).toBe(28);
  expect(consumer.exports.fd_write!(1, -1, 1, 40)).toBe(21);
  expect(consumer.exports.fd_write!(1, 0, 1, 65533)).toBe(21);
  iov(memory, [[100, 33]]);
  expect(consumer.exports.fd_write!(1, 0, 1, 40)).toBe(28);
  iov(memory, [[100, 2]]);
  budget.output = 63;
  expect(consumer.exports.fd_write!(1, 0, 1, 40)).toBe(51);
  expect(view.getUint32(40, true)).toBe(0xfeedface);
  expect(writes).toEqual([]);
  expect(budget.output).toBe(63);
  consumer.close();
});

test("fd permissions, closure, empty environment and fixed clocks are isolated", () => {
  const { source } = fixture();
  source.outputFds = [1];
  const options = prepareNumericWasi(source), budget = createNumericWasiBudget();
  source.outputFds.push(2); source.clock.realtimeNs = 999n; source.allowed.length = 0;
  const consumer = createNumericWasiConsumer(options, "a", budget, () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  consumer.bind(memory);
  expect(consumer.exports.fd_close!(0)).toBe(8);
  expect(consumer.exports.fd_close!(2)).toBe(8);
  expect(consumer.exports.fd_seek!(2, 0n, 0, 0)).toBe(8);
  expect(consumer.exports.fd_write!(2, 0, 0, 0)).toBe(8);
  expect(consumer.exports.fd_seek!(1, 0n, 0, 0)).toBe(70);
  expect(consumer.exports.fd_close!(1)).toBe(0);
  expect(consumer.exports.fd_close!(1)).toBe(8);
  expect(consumer.exports.fd_seek!(1, 0n, 0, 0)).toBe(8);
  expect(consumer.exports.environ_sizes_get!(0, 4)).toBe(0);
  expect(new DataView(memory.buffer).getBigUint64(0, true)).toBe(0n);
  expect(consumer.exports.environ_sizes_get!(65533, 4)).toBe(21);
  expect(consumer.exports.clock_time_get!(0, 0n, 8)).toBe(0);
  expect(new DataView(memory.buffer).getBigUint64(8, true)).toBe(123n);
  expect(consumer.exports.clock_time_get!(1, 0n, 8)).toBe(0);
  expect(new DataView(memory.buffer).getBigUint64(8, true)).toBe(456n);
  expect(consumer.exports.clock_time_get!(2, 0n, 8)).toBe(58);
  expect(consumer.exports.clock_time_get!(-1, 0n, 8)).toBe(28);
  expect(consumer.exports.clock_time_get!(0, 0n, 65529)).toBe(21);
  consumer.close();
  expect(() => consumer.exports.proc_exit!(0)).toThrow("unavailable");
  expect(consumer.exports.environ_sizes_get!(0, 4)).toBe(21);
});

test("permissions and bindings are explicit and proc_exit preserves u32 code", () => {
  const { source } = fixture();
  source.allowed = ["proc_exit"];
  const options = prepareNumericWasi(source), consumer = createNumericWasiConsumer(options, "a", createNumericWasiBudget(), () => {});
  expect(Object.keys(consumer.exports)).toEqual(["proc_exit"]);
  expect(() => consumer.exports.proc_exit!(-1)).toThrow("unavailable");
  const memory = new WebAssembly.Memory({ initial: 1 });
  consumer.bind(memory);
  try { consumer.exports.proc_exit!(-1); } catch (error) {
    expect(error).toBeInstanceOf(NumericWasiExit);
    expect((error as NumericWasiExit).code).toBe(0xffff_ffff);
  }
  expect(() => consumer.bind(memory)).toThrow("invalid numeric WASI memory binding");
  consumer.close();
  expect(() => consumer.bind(memory)).toThrow("invalid numeric WASI memory binding");
  expect(() => prepareNumericWasi({ ...source, allowed: ["clock_time_get"], clock: undefined })).toThrow("clock requires");
  expect(() => prepareNumericWasi({ ...source, outputFds: [1, 1] })).toThrow("output permissions");
});

test("a caught nested failure is checked before guest output and quota mutation", () => {
  const { source } = fixture();
  let poisoned = false;
  source.onWrite = () => { poisoned = true; };
  const budget = createNumericWasiBudget();
  const consumer = createNumericWasiConsumer(prepareNumericWasi(source), "a", budget, () => { if (poisoned) throw new Error("poisoned"); });
  const memory = new WebAssembly.Memory({ initial: 1 });
  consumer.bind(memory);
  iov(memory, [[100, 1]]);
  new DataView(memory.buffer).setUint32(40, 77, true);
  expect(() => consumer.exports.fd_write!(1, 0, 1, 40)).toThrow("poisoned");
  expect(new DataView(memory.buffer).getUint32(40, true)).toBe(77);
  expect(budget.output).toBe(0);
  consumer.close();
});

test("an asynchronous sink cannot commit the guest write or consume quota", () => {
  const { source } = fixture();
  source.onWrite = () => Promise.reject(new Error("sink rejection"));
  const budget = createNumericWasiBudget();
  const consumer = createNumericWasiConsumer(prepareNumericWasi(source), "a", budget, () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  consumer.bind(memory);
  iov(memory, [[100, 1]]);
  new DataView(memory.buffer).setUint32(40, 77, true);
  expect(() => consumer.exports.fd_write!(1, 0, 1, 40)).toThrow("sink must return undefined");
  expect(new DataView(memory.buffer).getUint32(40, true)).toBe(77);
  expect(budget.output).toBe(0);
  consumer.close();
});

test("real Wasm consumers use their bound memories and C reactor calls libc write", async () => {
  const { options, writes } = fixture(), budget = createNumericWasiBudget();
  const load = async (name: string) => new WebAssembly.Module(await Bun.file(`target/validator/wasi-numeric-fixtures/${name}.wasm`).bytes());
  const libModule = await load("lib"), appModule = await load("app"), cModule = await load("c-app");
  expect(WebAssembly.Module.imports(cModule).map(({ module, name }) => `${module}.${name}`)).toEqual(["wasi_snapshot_preview1.fd_write"]);
  const lib = createNumericWasiConsumer(options, "lib", budget, () => {});
  const libInstance = new WebAssembly.Instance(libModule, { wasi_snapshot_preview1: lib.exports });
  lib.bind(libInstance.exports.memory as WebAssembly.Memory);
  const app = createNumericWasiConsumer(options, "app", budget, () => {});
  const appInstance = new WebAssembly.Instance(appModule, { wasi_snapshot_preview1: app.exports, lib: { invoke: libInstance.exports.invoke as CallableFunction } });
  app.bind(appInstance.exports.memory as WebAssembly.Memory);
  const c = createNumericWasiConsumer(options, "c", createNumericWasiBudget(), () => {});
  const cInstance = new WebAssembly.Instance(cModule, { wasi_snapshot_preview1: c.exports });
  c.bind(cInstance.exports.memory as WebAssembly.Memory);
  for (const instance of [libInstance, appInstance, cInstance]) (instance.exports._initialize as () => void)();
  expect((cInstance.exports.module_init as () => number)()).toBe(0);
  const run = appInstance.exports.app_run as (value: number) => number;
  expect(run(0)).toBe(0);
  expect(run(100)).toBe(0);
  expect(run(1)).toBe(21);
  expect(run(2)).toBe(28);
  expect(run(3)).toBe(21);
  expect(run(4)).toBe(21);
  expect(run(5)).toBe(21);
  expect(run(6)).toBe(8);
  expect(run(7)).toBe(0);
  expect(run(8)).toBe(0);
  expect((appInstance.exports.memory as WebAssembly.Memory).buffer.byteLength).toBe(2 * 65536);
  expect((libInstance.exports.memory as WebAssembly.Memory).buffer.byteLength).toBe(65536);
  expect(run(9)).toBe(0);
  expect(run(10)).toBe(0);
  expect(run(11)).toBe(123);
  expect(run(17)).toBe(58);
  expect(run(16)).toBe(0);
  expect(run(12)).toBe(70);
  expect(run(13)).toBe(0);
  expect(run(0)).toBe(8);
  expect(run(100)).toBe(0);
  expect((cInstance.exports.app_run as (value: number) => number)(5)).toBe(6);
  expect(() => run(14)).toThrow(NumericWasiExit);
  expect((cInstance.exports.module_close as () => number)()).toBe(0);
  const decoder = new TextDecoder();
  expect(writes.map(({ consumer, bytes }) => [consumer, decoder.decode(bytes)])).toEqual([
    ["lib", "init"], ["app", "init"], ["c", "ci"], ["app", "APP!"], ["lib", "LIB!"],
    ["app", "GROW"], ["app", "APP!"], ["lib", "LIB!"], ["c", "C!"], ["c", "ce"],
  ]);
  lib.close(); app.close(); c.close();
});
