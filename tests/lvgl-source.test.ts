import { expect, test } from "bun:test";

test("LVGL source layouts share target discovery and reject conflicting inputs", () => {
  const result = Bun.spawnSync(["python3", "-B", "tests/lvgl-source.py"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 30_000);
