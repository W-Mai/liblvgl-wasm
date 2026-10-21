import { expect, test } from "bun:test";
import { loadResources, readResources } from "../studio/src/resources.ts";

test("resource uploads preserve bytes and reject invalid names", async () => {
  const resource = new File([new Uint8Array([1, 2, 3])], "icon.bin");
  const entries = await readResources([resource]);
  expect(entries[0]?.name).toBe("icon.bin");
  expect([...new Uint8Array(entries[0]!.bytes)]).toEqual([1, 2, 3]);
  expect(readResources([new File(["x"], "bad:name")])).rejects.toThrow("Invalid resource name");
  expect(readResources([resource, resource])).rejects.toThrow("Duplicate resource name");
});

test("sample and uploaded resources share names, byte limits, and ownership", async () => {
  const sample = [{ name: "sample.bin", url: "data:application/octet-stream;base64,AQID" }];
  const uploaded = new File([new Uint8Array([4, 5])], "upload.bin");
  const entries = await loadResources(sample, [uploaded]);
  expect(entries.map(({ name }) => name)).toEqual(["sample.bin", "upload.bin"]);
  expect(entries.map(({ bytes }) => [...new Uint8Array(bytes)])).toEqual([[1, 2, 3], [4, 5]]);
  new Uint8Array(entries[0]!.bytes).fill(0);
  expect([...new Uint8Array((await loadResources(sample, []))[0]!.bytes)]).toEqual([1, 2, 3]);
  await expect(loadResources(sample, [new File(["x"], "sample.bin")])).rejects.toThrow("Duplicate resource name: sample.bin");
  await expect(loadResources([...sample, ...sample], [])).rejects.toThrow("Duplicate resource name");
  await expect(loadResources([{ ...sample[0]!, name: "bad:name" }], [])).rejects.toThrow("Invalid resource name");
  await expect(loadResources(sample, Array.from({ length: 32 }, (_, i) => new File(["x"], `${i}.bin`))))
    .rejects.toThrow("at most 32 resource files");
  const maximum = new Uint8Array(16 * 1024 * 1024);
  await expect(loadResources(sample, [new File([maximum], "a.bin"), new File([maximum], "b.bin")]))
    .rejects.toThrow("32 MiB session limit");
  await expect(loadResources(sample, [new File([maximum, "x"], "big.bin")]))
    .rejects.toThrow("between 1 byte and 16 MiB");
  await expect(loadResources([{ name: "empty.bin", url: "data:," }], [])).rejects.toThrow("between 1 byte and 16 MiB");
  expect((await loadResources([], [uploaded])).map(({ name }) => name)).toEqual(["upload.bin"]);
});
