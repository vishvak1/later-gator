export type SignedCatalogKind = "model-catalog" | "storage-plan-catalog";

/** Serializes JSON-compatible catalog data with stable object-key ordering. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("catalog_value_not_json");
}

/** Produces purpose-separated signing bytes for an immutable runtime release manifest. */
export function runtimeReleaseSigningBytes(
  manifest: Record<string, unknown>,
): Uint8Array<ArrayBuffer> {
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "signature"),
  );
  return new TextEncoder().encode(`later-gator:runtime-release:v1\n${stableJson(unsigned)}`);
}

/** Produces purpose-separated signing bytes while excluding the signature itself. */
export function catalogSigningBytes(
  kind: SignedCatalogKind,
  catalog: Record<string, unknown>,
): Uint8Array<ArrayBuffer> {
  const unsigned = Object.fromEntries(
    Object.entries(catalog).filter(([key]) => key !== "signature"),
  );
  return new TextEncoder().encode(`later-gator:${kind}:v1\n${stableJson(unsigned)}`);
}
