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
  "toolchains/ts/samples/svg.ts",
  "tests/fixtures/svg/geometry.svg",
  "tests/fixtures/svg/gradient.svg",
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

test("markup highlighting separates tags, attributes, values, and literal content", () => {
  const source = '<?xml version="1.0"?>\n<!-- fill="red" -->\n<svg viewBox="0 0 32 24"><path fill=\'url(#paint)\' d="M0 0>1"/>plain="text"<![CDATA[<path fill="red"/>]]></svg>';
  for (const extension of ["svg", "xml"]) {
    const tokens = tokenizeSource(source, `image.${extension}`);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    for (const [text, kind] of [
      ['<?xml version="1.0"?>', "directive"], ['<!-- fill="red" -->', "comment"],
      ["<svg", "keyword"], ["</svg", "keyword"], ["viewBox", "type"], ["fill", "type"],
      ['"0 0 32 24"', "string"], ["'url(#paint)'", "string"], ['"M0 0>1"', "string"],
      ["plain", undefined], ['"text"', undefined], ['<![CDATA[<path fill="red"/>]]>', undefined],
    ]) expect(tokens.find((token) => token.text === text)).toEqual({ text, kind });
  }
});
