export function assetUrl(path: string): string {
  if (typeof globalThis.location === "undefined") return path;
  const siteRoot = new URL("../", globalThis.location.href);
  return new URL(path.replace(/^\/+/, ""), siteRoot).toString();
}
