import { expect, test } from "bun:test";

test.skipIf(!Bun.env.LVW_TEST_PACKAGE)("relocated package runs TypeScript and Rust hosts", () => {
  const browser = Bun.env.LVW_TEST_BROWSER;
  const result = Bun.spawnSync(["python3", "-B", "tests/package-consumer.py", Bun.env.LVW_TEST_PACKAGE!,
    ...(browser ? ["--chromium", browser] : []),
    ...(Bun.env.LVW_ALLOW_DIRTY ? ["--allow-dirty"] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  if (browser && stdout.trim()) console.log(stdout.trim());
  expect(result.exitCode, stdout + new TextDecoder().decode(result.stderr)).toBe(0);
}, 900_000);
