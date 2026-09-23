import { expect, test } from "bun:test";
import { readResources } from "../studio/src/resources.ts";

test("resource uploads preserve bytes and reject invalid names", async () => {
  const resource = new File([new Uint8Array([1, 2, 3])], "icon.bin");
  const entries = await readResources([resource]);
  expect(entries[0]?.name).toBe("icon.bin");
  expect([...new Uint8Array(entries[0]!.bytes)]).toEqual([1, 2, 3]);
  expect(readResources([new File(["x"], "bad:name")])).rejects.toThrow("Invalid resource name");
  expect(readResources([resource, resource])).rejects.toThrow("Duplicate resource name");
});
