import { expect, test } from "bun:test";
import { tokenizeSource } from "../studio/src/highlight.ts";

const sources = [
  "toolchains/js/app.js",
  "toolchains/ts/app.ts",
  "toolchains/c/app.c",
  "toolchains/c/build.sh",
  "toolchains/cpp/app.cpp",
  "toolchains/cpp/build.sh",
  "toolchains/rust/src/lib.rs",
  "toolchains/rust/build.sh",
  "toolchains/include/lvw_app.h",
  "toolchains/rust/Cargo.toml",
  "examples/c/direct_api.c",
];

test("highlighting preserves displayed source text", async () => {
  for (const path of sources) {
    const source = await Bun.file(path).text();
    const tokens = tokenizeSource(source, path);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens.some((token) => token.kind)).toBe(true);
  }
});

test("comment markers inside strings remain strings", () => {
  const tokens = tokenizeSource('const url = "https://example.test"; // note\n', "app.js");
  expect(tokens.find((token) => token.text.includes("https://"))?.kind).toBe("string");
  expect(tokens.find((token) => token.text.startsWith("// note"))?.kind).toBe("comment");
});
