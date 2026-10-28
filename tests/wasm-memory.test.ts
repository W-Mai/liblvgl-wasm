import { expect, test } from "bun:test";

test("Wasm memory reports preserve imported and defined indices and limits", () => {
  const result = Bun.spawnSync(["python3", "-B", "tests/wasm-memory.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
});
