import { expect, test } from "bun:test";

test.skipIf(!Bun.env.LVW_TEST_PACKAGE)("relocated package runs TypeScript and Rust hosts", () => {
  const result = Bun.spawnSync(["python3", "-B", "tests/package-consumer.py", Bun.env.LVW_TEST_PACKAGE!], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
}, 900_000);
