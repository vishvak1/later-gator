export class RequestBodyError extends Error {
  override readonly name = "RequestBodyError";

  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export async function readBoundedUrlEncodedForm(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new RequestBodyError(415, "Expected a form submission.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > maxBytes) {
    throw new RequestBodyError(413, "Request body is too large.");
  }

  const body = request.body;
  if (body === null) return new URLSearchParams();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RequestBodyError(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyError(400, "Form body is not valid UTF-8.");
  } finally {
    bytes.fill(0);
  }
}
