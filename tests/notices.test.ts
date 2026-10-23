import { expect, test } from "bun:test";

test("notice packages preserve selected-source identity and publication boundaries", async () => {
  const child = Bun.spawn(["python3", "-B", "tests/notices.py"], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(status, stdout + stderr).toBe(0);
});
