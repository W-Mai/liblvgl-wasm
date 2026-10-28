import { expect, test } from "bun:test";
import { attachCapabilityManifest, parseCapabilityManifest } from "../studio/src/capabilities.ts";
import type { ArtifactReport } from "../studio/src/artifacts.ts";

const sha = (character: string) => character.repeat(64);

function manifest() {
  return parseCapabilityManifest({
    schema_version: 1,
    kind: "liblvgl-wasm-capabilities",
    identity: {
      source_revision: "5d70e6c",
      config_sha256: sha("a"),
      api_sha256: sha("b"),
      wasm_sha256: sha("c"),
    },
    lvgl: { version: { major: 9, minor: 6, patch: 0, info: "" } },
    capabilities: {
      core: { declared: "yes", enabled: "enabled", adapted: "not-applicable", runtime_verification: "not-run" },
      timer: { declared: "yes", enabled: "enabled", adapted: "enabled", runtime_verification: "not-run" },
      png: { declared: "yes", enabled: "disabled", adapted: "not-applicable", runtime_verification: "not-run" },
    },
  });
}

const report: ArtifactReport = {
  kind: "lvgl-core", mode: "lvgl-app", sha256: sha("c"), bytes: 4,
  imports: [], exports: [], capabilities: [], reasons: [], identity: { sdk: "unknown" },
};

test("attaches only a manifest bound to the selected core", () => {
  const attached = attachCapabilityManifest(report, manifest());
  expect(attached.manifest?.version).toBe("9.6.0");
  expect(attached.manifest?.sourceRevision).toBe("5d70e6c");
  expect(attached.capabilities.map((entry) => [entry.id, entry.state])).toEqual([
    ["manifest.identity", "available"], ["manifest.configuration", "available"],
    ["manifest.core", "available"], ["manifest.png", "missing"], ["manifest.timer", "adapted"],
  ]);
});

test("rejects a manifest with a different core hash", () => {
  expect(() => attachCapabilityManifest({ ...report, sha256: sha("d") }, manifest())).toThrow("does not match");
});

test("rejects malformed manifest identity and preserves unknown statuses", () => {
  expect(() => parseCapabilityManifest({ schema_version: 1, kind: "liblvgl-wasm-capabilities" })).toThrow();
  const value = manifest();
  const unknown = parseCapabilityManifest({
    schema_version: value.schema_version,
    kind: value.kind,
    identity: value.identity,
    lvgl: value.lvgl,
    capabilities: { custom: { declared: "unknown", enabled: "unknown", adapted: "unknown", runtime_verification: "not-run" } },
  });
  const attached = attachCapabilityManifest(report, unknown);
  expect(attached.capabilities.at(-1)?.state).toBe("unknown");
});
