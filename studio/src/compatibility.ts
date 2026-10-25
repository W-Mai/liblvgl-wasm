export interface CompatibilityAdapterEntry {
  id: string;
  sourceSha256: string;
  coreSha256: string;
  capabilities: readonly string[];
}

/** Resolve an adapter only from a caller-supplied exact-identity registry. */
export function resolveCompatibilityAdapter(
  identity: { sourceSha256: string; coreSha256: string },
  registry: readonly CompatibilityAdapterEntry[],
): CompatibilityAdapterEntry | undefined {
  return registry.find((entry) => entry.coreSha256 === identity.coreSha256
    && entry.sourceSha256 === identity.sourceSha256);
}
