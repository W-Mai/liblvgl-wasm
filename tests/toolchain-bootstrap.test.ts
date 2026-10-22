import { expect, test } from "bun:test";

test("tool preparation preserves cache and archive boundaries", () => {
  const result = Bun.spawnSync(["python3", "-B", "tests/toolchain-bootstrap.py"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 30_000);
