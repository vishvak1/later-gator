export const SESSION_COOKIE = "lg_cp_session";
export const CSRF_COOKIE = "lg_cp_csrf";
export const OAUTH_STATE_COOKIE = "lg_cp_oauth_state";
export const INSTALLER_STATE_COOKIE = "lg_cp_installer_state";
export const EXTENSION_REQUEST_COOKIE = "lg_cp_extension_request";
export const RUNTIME_LOGIN_COOKIE = "lg_cp_runtime_login";

export interface CookieOptions {
  httpOnly: boolean;
  maxAge: number;
  sameSite: "Lax" | "Strict";
  secure: boolean;
}

/** Parses request cookies without treating malformed values as authentication data. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Serializes a host-scoped cookie with an explicit lifetime and SameSite policy. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAge.toString()}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Expires a previously issued host-scoped cookie. */
export function expireCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { httpOnly: true, maxAge: 0, sameSite: "Lax", secure });
}
