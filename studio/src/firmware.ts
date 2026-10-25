import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createWasiImports } from "../../bindings/typescript/src/wasi.ts";
import { inspectArtifact } from "./artifacts.ts";
import type { FirmwareRuntimeReport } from "./protocol.ts";

const ABI_VERSION = 1;

interface FirmwareExports {
  memory: WebAssembly.Memory;
  lvw_firmware_abi_version(): number;
  lvw_firmware_init(width: number, height: number): number;
  lvw_firmware_step(elapsedMs: number): number;
  lvw_firmware_frame_ptr(): number;
  lvw_firmware_frame_len(): number;
  lvw_firmware_pointer(x: number, y: number, pressed: number): void;
  lvw_firmware_shutdown(): void;
}

export function copyFirmwareFrame(memory: WebAssembly.Memory, pointer: number, length: number,
                                  width: number, height: number): ArrayBuffer {
  if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 0) {
    throw new Error("Firmware returned an invalid frame range");
  }
  const expected = width * height * 4;
  if (length !== expected || pointer > memory.buffer.byteLength - length) {
    throw new Error(`Firmware frame must be ${expected} bytes within exported memory`);
  }
  return new Uint8Array(memory.buffer, pointer, length).slice().buffer;
}

export class FirmwareRuntime {
  private constructor(
    private readonly raw: FirmwareExports,
    readonly width: number,
    readonly height: number,
    readonly report: FirmwareRuntimeReport,
  ) {}

  static async load(bytes: BufferSource, width: number, height: number): Promise<FirmwareRuntime> {
    const snapshot = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
      : new Uint8Array(bytes).slice();
    const preflight = await inspectArtifact(snapshot, "application");
    if (preflight.kind !== "firmware" || preflight.mode !== "firmware") {
      throw new Error(preflight.reasons.join(" ") || "The module does not implement firmware ABI 1.");
    }
    let memory: WebAssembly.Memory | undefined;
    const module = await WebAssembly.compile(snapshot as unknown as ArrayBuffer);
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: createWasiImports(() => memory),
    });
    const raw = instance.exports as unknown as FirmwareExports;
    memory = raw.memory;
    const abi = raw.lvw_firmware_abi_version();
    if (abi !== ABI_VERSION) throw new Error(`Unsupported firmware ABI: ${abi}`);
    if (raw.lvw_firmware_init(width, height) !== 0) throw new Error("Firmware initialization failed");
    return new FirmwareRuntime(raw, width, height, { abi, sha256: bytesToHex(sha256(snapshot)) });
  }

  step(elapsedMs: number): boolean {
    return this.raw.lvw_firmware_step(elapsedMs) !== 0;
  }

  frame(): ArrayBuffer {
    return copyFirmwareFrame(this.raw.memory, this.raw.lvw_firmware_frame_ptr(),
      this.raw.lvw_firmware_frame_len(), this.width, this.height);
  }

  pointer(x: number, y: number, pressed: boolean): void {
    this.raw.lvw_firmware_pointer(x, y, pressed ? 1 : 0);
  }

  shutdown(): void {
    this.raw.lvw_firmware_shutdown();
  }
}

