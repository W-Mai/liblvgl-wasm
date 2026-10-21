export const WASI_IMPORT_NAMES = [
  "fd_close", "fd_seek", "fd_write", "environ_get", "environ_sizes_get", "proc_exit",
] as const;

/** Minimal WASIp1 services for the core; no host environment or filesystem. */
export function createWasiImports(getMemory: () => WebAssembly.Memory | undefined) {
  const decoder = new TextDecoder();
  return {
    fd_close() { return 0; },
    fd_seek(fd: number, _offset: bigint, _whence: number, _result: number) {
      return fd >= 0 && fd <= 2 ? 70 : 8;
    },
    fd_write(fd: number, iovPointer: number, iovCount: number, writtenPointer: number) {
      const memory = getMemory();
      if (!memory) return 8;
      const view = new DataView(memory.buffer);
      const chunks: Uint8Array[] = [];
      let written = 0;
      for (let index = 0; index < iovCount; index++) {
        const pointer = view.getUint32(iovPointer + index * 8, true);
        const length = view.getUint32(iovPointer + index * 8 + 4, true);
        chunks.push(new Uint8Array(memory.buffer, pointer, length));
        written += length;
      }
      view.setUint32(writtenPointer, written, true);
      const line = decoder.decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
      if (line.trim()) (fd === 2 ? console.error : console.log)(line.trimEnd());
      return 0;
    },
    environ_get(_environment: number, _buffer: number) { return 0; },
    environ_sizes_get(count: number, size: number) {
      const memory = getMemory();
      if (!memory) return 21;
      count >>>= 0;
      size >>>= 0;
      if (count > memory.buffer.byteLength - 4 || size > memory.buffer.byteLength - 4) return 21;
      const view = new DataView(memory.buffer);
      view.setUint32(count, 0, true);
      view.setUint32(size, 0, true);
      return 0;
    },
    proc_exit(code: number): never {
      throw new Error(`WASI process exited with code ${code >>> 0}`);
    },
  };
}
