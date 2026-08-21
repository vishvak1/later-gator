import { ControlPlaneError } from "../domain/errors";

/** Reads a remote JSON response without allowing an unbounded provider body. */
export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ControlPlaneError("identity_provider_unavailable", 503);
  }
}
