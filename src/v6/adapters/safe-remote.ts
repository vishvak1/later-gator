function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0"
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export function safeRemoteUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    isBlockedHostname(url.hostname)
  ) {
    throw new Error("unsafe_remote_url");
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new Error("unsafe_remote_url");
  }
  return url;
}

export async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) throw new Error("remote_content_too_large");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > maximum) throw new Error("remote_content_too_large");
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function safeFetch(raw: string, accept: string): Promise<Response> {
  let target = safeRemoteUrl(raw);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(target, {
      redirect: "manual",
      headers: {
        accept,
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 " +
          "LaterGator/6.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (location === null) throw new Error("remote_redirect_missing");
    target = safeRemoteUrl(new URL(location, target).toString());
  }
  throw new Error("remote_redirect_limit");
}

/** Resolves one redirect hop (e.g. a t.co shortlink) without following it. */
export async function resolveRedirectTarget(raw: string): Promise<string | null> {
  const target = safeRemoteUrl(raw);
  const response = await fetch(target, {
    redirect: "manual",
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 " +
        "LaterGator/6.0",
    },
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (location === null) return null;
  return safeRemoteUrl(new URL(location, target).toString()).toString();
}
