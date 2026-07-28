export interface NormalizedBookmarkUrl {
  url: string;
  normalizedUrl: string;
  hostname: string;
}

export class UnsafeBookmarkUrlError extends Error {
  constructor() {
    super("Only public HTTP and HTTPS bookmark URLs are supported.");
    this.name = "UnsafeBookmarkUrlError";
  }
}

export function normalizeBookmarkUrl(raw: string): NormalizedBookmarkUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeBookmarkUrlError();
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeBookmarkUrlError();
  }

  parsed.hash = "";
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  if (parsed.pathname === "") parsed.pathname = "/";

  return {
    url: raw,
    normalizedUrl: parsed.toString(),
    hostname: parsed.hostname,
  };
}
