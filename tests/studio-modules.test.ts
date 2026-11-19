import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

test("Studio's C library callback and application remain separate Wasm modules", async () => {
  const root = "target/studio/modules/";
  const project = JSON.parse(readFileSync(root + "project.json", "utf8"));
  const build = JSON.parse(readFileSync(root + "build.json", "utf8"));
  expect(project.kind).toBe("studio-module-project");
  expect(build.kind).toBe("studio-module-build");
  expect(project.modules.map((item: any) => item.manifest.id).sort()).toEqual(["app", "lvcore", "middle"]);
  const facts = new Map<string, ReturnType<typeof inspectWasmFacts>>();
  for (const item of project.modules) {
    const bytes = readFileSync(root + item.manifest.artifact.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.manifest.artifact.sha256);
    await WebAssembly.compile(bytes);
    facts.set(item.manifest.id, inspectWasmFacts(bytes));
  }
  expect(facts.get("app")!.imports.every((item) => ["middle", "trace"].includes(item.module))).toBe(true);
  expect(facts.get("middle")!.imports.some((item) => item.module === "lvgl" && item.name === "lv_obj_add_event_cb")).toBe(true);
  expect(facts.get("middle")!.exports.some((item) => item.name === "app_event_dispatch" && item.kind === "function")).toBe(true);
  expect(facts.get("middle")!.tables).toHaveLength(1);
  expect(typeof facts.get("middle")!.tables[0]!.type.maximum).toBe("number");
  const wasi = project.hosts.find((host: { interface: { name: string } }) => host.interface.name === "wasi");
  expect(wasi.exports.map((item: { name: string }) => item.name).sort()).toEqual([...new Set(facts.get("lvcore")!.imports
    .filter((item) => item.module === "wasi_snapshot_preview1").map((item) => item.name))].sort());
  for (const [path, sha] of Object.entries(build.files)) {
    expect(path.startsWith("/") || path.split("/").some((part) => part === "..")).toBe(false);
    expect(createHash("sha256").update(readFileSync(root + path)).digest("hex")).toBe(sha);
  }
  for (const [path, sha] of Object.entries(build.inputs)) {
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(sha);
  }
});
