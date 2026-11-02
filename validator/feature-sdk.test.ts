import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("optional feature SDK runs from a read-only relocated package", async () => {
  const output = await mkdtemp(join(tmpdir(), "lvw feature sdk "));
  try {
    const child = Bun.spawn(["python3", "-B", "tests/feature-sdk-build.py", output], { stdout: "ignore", stderr: "inherit" });
    expect(await child.exited).toBe(0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 300_000);
