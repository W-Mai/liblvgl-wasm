import { expect, test } from "bun:test";

test("package manifest verification rejects drift and requires clean release state", () => {
  const result = Bun.spawnSync(["python3", "-B", "tests/package-manifest.py"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
});
