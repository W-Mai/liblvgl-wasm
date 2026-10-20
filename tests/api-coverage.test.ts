import { expect, test } from "bun:test";

interface ApiEntry {
  name: string;
  category: "direct_export" | "abi_shim" | "compile_disabled" | "unsupported";
  export_name: string | null;
  abi_signature: string | null;
  reason: string | null;
}

test("API inventory matches the Wasm exports", async () => {
  const report = await Bun.file("target/wasm/api.json").json() as {
    summary: Record<ApiEntry["category"] | "total", number>;
    declarations: ApiEntry[];
  };
  const module = await WebAssembly.compile(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  const actual = new Set(WebAssembly.Module.exports(module).map((item) => item.name));

  expect(report.summary.total).toBe(report.declarations.length);
  expect(report.summary.total).toBeGreaterThan(0);
  for (const category of ["direct_export", "abi_shim", "compile_disabled", "unsupported"] as const) {
    expect(report.summary[category]).toBe(report.declarations.filter((entry) => entry.category === category).length);
  }
  for (const entry of report.declarations) {
    if (entry.category === "direct_export" || entry.category === "abi_shim") {
      expect(entry.export_name).not.toBeNull();
      expect(actual.has(entry.export_name!)).toBe(true);
      expect(entry.reason).toBeNull();
      if (entry.category === "abi_shim") expect(entry.abi_signature).not.toBeNull();
    } else {
      expect(entry.export_name).toBeNull();
      expect(entry.reason).not.toBeNull();
    }
  }
});

test("aggregate value shims pass color values through Wasm memory", async () => {
  const report = await Bun.file("target/wasm/api.json").json() as {
    types: Record<string, { kind: string; name?: string; layout: { status: string; size: number | null } }>;
  };
  const colorType = Object.values(report.types).find(
    (node) => node.kind === "alias" && node.name === "lv_color_t",
  );
  expect(colorType?.layout.status).toBe("complete");
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    lvw: {
      event() {}, timer() {}, timer_release() {},
      anim_exec() {}, anim_query() { return 0; }, anim_notify() {}, anim_release() {},
      observer() {}, observer_release() {},
    },
    wasi_snapshot_preview1: { fd_close() { return 0; }, fd_seek() { return 70; }, fd_write() { return 0; } },
  });
  const raw = instance.exports as unknown as {
    _initialize(): void;
    lvw_alloc(size: number): number;
    lvw_free(pointer: number): void;
    lvw_api_lv_color_hex(out: number, rgb: number): void;
    lvw_api_lv_color_to_int(color: number): number;
  };
  raw._initialize();
  const color = raw.lvw_alloc(colorType!.layout.size!);
  expect(color).not.toBe(0);
  raw.lvw_api_lv_color_hex(color, 0x123456);
  expect(raw.lvw_api_lv_color_to_int(color)).toBe(0x123456);
  raw.lvw_free(color);
});
