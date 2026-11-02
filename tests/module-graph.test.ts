import { expect, test } from "bun:test";
import { orderModuleGraph, type ModuleDeclaration } from "../bindings/typescript/src/index.ts";

test("module declarations produce the same provider-first order for any input order", () => {
  const modules: ModuleDeclaration[] = [
    { id: "app-a", role: "app", requires: [{ provider: "widgets" }, { provider: "lvgl" }, { provider: "host.clock" }] },
    { id: "widgets", role: "lib", requires: [{ provider: "lvgl", interface: "drawing" }, { provider: "lvgl", interface: "input" }] },
    { id: "lvgl", role: "lib", requires: [{ provider: "host.clock" }] },
    { id: "app-b", role: "app", requires: [{ provider: "lvgl" }] },
    { id: "other", role: "lib", requires: [] },
  ];
  const expected = ["lvgl", "other", "widgets", "app-a", "app-b"];
  for (let i = 0; i < modules.length; i++) {
    const rotated = [...modules.slice(i), ...modules.slice(0, i)];
    for (const ordered of [rotated, [...rotated].reverse()]) {
      expect(orderModuleGraph({ modules: ordered, hostProviders: ["host.clock"] })).toEqual(expected);
    }
  }
});

test("ready library and app IDs use UTF-16 code-unit order", () => {
  expect(orderModuleGraph({ hostProviders: [], modules: [
    { id: "\ue000", role: "lib", requires: [] },
    { id: "😀", role: "lib", requires: [] },
    { id: "app.\ue000", role: "app", requires: [] },
    { id: "app.😀", role: "app", requires: [] },
  ] })).toEqual(["😀", "\ue000", "app.😀", "app.\ue000"]);
});

test("module, host and dependency IDs reject unpaired surrogates", () => {
  const module = (id: string, provider: string): ModuleDeclaration => ({ id, role: "lib", requires: [{ provider }] });
  expect(() => orderModuleGraph({ modules: [module("\ud800", "host")], hostProviders: ["host"] })).toThrow("Invalid module ID");
  expect(() => orderModuleGraph({ modules: [], hostProviders: ["host\udc00"] })).toThrow("Invalid host provider ID");
  expect(() => orderModuleGraph({ modules: [module("a", "\ud800x")], hostProviders: [] })).toThrow('Invalid provider ID: "a"');
  expect(() => orderModuleGraph({ modules: [module("a", "x\udc00")], hostProviders: [] })).toThrow('Invalid provider ID: "a"');
  expect(orderModuleGraph({ modules: [module("😀", "host.😀")], hostProviders: ["host.😀"] })).toEqual(["😀"]);
});

test("module graph rejects invalid provider edges and identities", () => {
  const lib = (id: string, ...providers: string[]): ModuleDeclaration => ({
    id, role: "lib", requires: providers.map((provider) => ({ provider })),
  });
  const app: ModuleDeclaration = { id: "app", role: "app", requires: [] };
  const order = (modules: ModuleDeclaration[], hostProviders: string[] = []) => orderModuleGraph({ modules, hostProviders });
  expect(() => order([lib("a"), lib("a")])).toThrow('Duplicate provider ID: "a"');
  expect(() => order([lib("a")], ["a"])).toThrow('Duplicate provider ID: "a"');
  expect(() => order([], ["host", "host"])).toThrow('Duplicate provider ID: "host"');
  expect(() => order([], [""])).toThrow("Invalid host provider ID");
  expect(() => order([lib("a", "missing")])).toThrow('Missing provider: "a" -> "missing"');
  expect(() => order([lib("a", "app"), app])).toThrow('App cannot be a provider: "a" -> "app"');
  expect(() => order([{ id: "other-app", role: "app", requires: [{ provider: "app" }] }, app])).toThrow('App cannot be a provider: "other-app" -> "app"');
  expect(() => order([lib("a", "a")])).toThrow('Self dependency: "a" -> "a"');
  expect(() => order([lib("a", "b"), lib("b", "c"), lib("c", "a")])).toThrow('Library dependency cycle: "a" -> "b" -> "c" -> "a"');
  expect(() => order([lib(" a")])).toThrow("Invalid module ID");
  expect(() => order([{ id: "bad", role: "host" as "lib", requires: [] }])).toThrow('Invalid module role: "bad"');
  expect(() => order([lib("a -> b\nline", "missing\nnext")])).toThrow('Missing provider: "a -> b\\nline" -> "missing\\nnext"');
  expect(() => order([lib("a -> b", "x\ny"), lib("x\ny", "a -> b")])).toThrow('Library dependency cycle: "a -> b" -> "x\\ny" -> "a -> b"');
});
