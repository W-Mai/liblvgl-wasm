import { expect, test } from "bun:test";

for (const language of ["c", "cpp", "rust"]) {
  test(`${language} application exports ABI 1 with host-only imports`, async () => {
    const bytes = await Bun.file(`target/apps/${language}/app.wasm`).arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(module);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((item) => item.module === "lvw_app")).toBe(true);
    const exports = WebAssembly.Module.exports(module).map((item) => item.name);
    for (const name of ["memory", "app_abi_version", "app_init", "app_event"]) {
      expect(exports).toContain(name);
    }
  });
}
