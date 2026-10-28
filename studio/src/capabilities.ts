import type { ArtifactCapability, ArtifactReport, CapabilityState } from "./artifacts.ts";

type CapabilityStatus = {
  declared: string;
  enabled: string;
  adapted: string;
  runtime_verification: string;
};

export interface CapabilityManifest {
  schema_version: 1;
  kind: "liblvgl-wasm-capabilities";
  identity: {
    source_revision: string;
    config_sha256: string;
    api_sha256: string;
    wasm_sha256: string;
  };
  lvgl: { version: { major: number | null; minor: number | null; patch: number | null; info: string | null } };
  capabilities: Record<string, CapabilityStatus>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be a lowercase SHA-256`);
  return result;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer or null`);
  return value;
}

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  const root = object(value, "Capability manifest");
  if (root.schema_version !== 1 || root.kind !== "liblvgl-wasm-capabilities") {
    throw new Error("Unsupported capability manifest");
  }
  const identity = object(root.identity, "Capability manifest identity");
  const versionRoot = object(object(root.lvgl, "Capability manifest LVGL").version, "Capability manifest version");
  const capabilitiesRoot = object(root.capabilities, "Capability manifest capabilities");
  const capabilities: Record<string, CapabilityStatus> = {};
  for (const [name, raw] of Object.entries(capabilitiesRoot)) {
    const entry = object(raw, `Capability ${name}`);
    capabilities[name] = {
      declared: text(entry.declared, `Capability ${name}.declared`),
      enabled: text(entry.enabled, `Capability ${name}.enabled`),
      adapted: text(entry.adapted, `Capability ${name}.adapted`),
      runtime_verification: text(entry.runtime_verification, `Capability ${name}.runtime_verification`),
    };
  }
  return {
    schema_version: 1,
    kind: "liblvgl-wasm-capabilities",
    identity: {
      source_revision: text(identity.source_revision, "Capability manifest source_revision"),
      config_sha256: sha(identity.config_sha256, "Capability manifest config_sha256"),
      api_sha256: sha(identity.api_sha256, "Capability manifest api_sha256"),
      wasm_sha256: sha(identity.wasm_sha256, "Capability manifest wasm_sha256"),
    },
    lvgl: { version: {
      major: nullableNumber(versionRoot.major, "Capability manifest LVGL major"),
      minor: nullableNumber(versionRoot.minor, "Capability manifest LVGL minor"),
      patch: nullableNumber(versionRoot.patch, "Capability manifest LVGL patch"),
      info: versionRoot.info === null ? null : typeof versionRoot.info === "string"
        ? versionRoot.info : (() => { throw new Error("Capability manifest LVGL info must be a string or null"); })(),
    } },
    capabilities,
  };
}

function state(entry: CapabilityStatus): CapabilityState {
  if (entry.runtime_verification === "verified") return "available";
  if (entry.adapted === "enabled") return "adapted";
  if (entry.enabled === "enabled") return "available";
  if (entry.enabled === "disabled") return "missing";
  return "unknown";
}

function version(manifest: CapabilityManifest): string {
  const { major, minor, patch, info } = manifest.lvgl.version;
  if (major === null || minor === null || patch === null) return "unknown";
  return `${major}.${minor}.${patch}${info ?? ""}`;
}

export function attachCapabilityManifest(report: ArtifactReport, manifest: CapabilityManifest): ArtifactReport {
  if (manifest.identity.wasm_sha256 !== report.sha256) {
    throw new Error("Capability manifest core SHA-256 does not match the selected library");
  }
  const rows: ArtifactCapability[] = [
    { id: "manifest.identity", state: "available", detail: `Matches core SHA-256; LVGL ${version(manifest)}.` },
    { id: "manifest.configuration", state: "available", detail: `Configuration SHA-256 ${manifest.identity.config_sha256}.` },
  ];
  for (const name of Object.keys(manifest.capabilities).sort()) {
    const entry = manifest.capabilities[name];
    rows.push({ id: `manifest.${name}`, state: state(entry), detail:
      `enabled=${entry.enabled}; adapted=${entry.adapted}; runtime=${entry.runtime_verification}.` });
  }
  return {
    ...report,
    capabilities: [...report.capabilities, ...rows],
    manifest: {
      sourceRevision: manifest.identity.source_revision,
      apiSha256: manifest.identity.api_sha256,
      configSha256: manifest.identity.config_sha256,
      version: version(manifest),
    },
  };
}
