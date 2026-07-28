export function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(value, { ...init, headers });
}

export function apiError(status: number, code: string, message: string): Response {
  return json(
    {
      ok: false,
      error: { code, message, requestId: crypto.randomUUID() },
    },
    { status },
  );
}

export async function readJson(request: Request, maximumBytes = 64 * 1024): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("request_too_large");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new Error("request_too_large");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function redirect(request: Request, path: string): Response {
  return Response.redirect(new URL(path, request.url), 303);
}

