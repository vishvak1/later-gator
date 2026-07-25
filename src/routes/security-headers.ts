export function setupHtmlHeaders(contentSecurityPolicy: string): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
}
