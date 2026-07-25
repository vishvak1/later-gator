import { z } from "zod";

const SESSION_TTL_SECONDS = 30 * 60;
const COOKIE_NAME = "later_gator_setup";
const InstallationSecretSchema = z.object({
  INSTALLATION_SECRET: z.string().min(16),
});

export interface SetupSession {
  expiresAt: number;
  csrfToken: string;
}

export function getInstallationSecret(env: Env): string {
  return InstallationSecretSchema.parse(env).INSTALLATION_SECRET;
}

export async function createSetupSessionCookie(env: Env): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sessionId = crypto.randomUUID();
  const csrfToken = randomToken();
  const payload = `${expiresAt.toString()}.${sessionId}.${csrfToken}`;
  const signature = await sign(payload, getInstallationSecret(env));

  return `${COOKIE_NAME}=${encodeURIComponent(`${payload}.${signature}`)}; Path=/; Max-Age=${SESSION_TTL_SECONDS.toString()}; Secure; HttpOnly; SameSite=Strict`;
}

export async function readSetupSession(request: Request, env: Env): Promise<SetupSession | null> {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (cookie === undefined) return null;

  const value = decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1));
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [expiresAtRaw, sessionId, csrfToken, suppliedSignature] = parts;
  if (
    expiresAtRaw === undefined ||
    sessionId === undefined ||
    csrfToken === undefined ||
    suppliedSignature === undefined
  ) {
    return null;
  }
  if (!/^\d+$/u.test(expiresAtRaw)) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;

  const expectedSignature = await sign(
    `${expiresAtRaw}.${sessionId}.${csrfToken}`,
    getInstallationSecret(env),
  );
  if (!(await secretsEqual(expectedSignature, suppliedSignature))) return null;

  return { expiresAt, csrfToken };
}

export async function requireSetupMutation(
  request: Request,
  env: Env,
  submittedCsrfToken: string | null,
): Promise<Response | SetupSession> {
  const session = await readSetupSession(request, env);
  if (session === null) return new Response(null, { status: 401 });

  const requestOrigin = request.headers.get("origin");
  const expectedOrigin = new URL(request.url).origin;
  if (requestOrigin !== expectedOrigin) return new Response(null, { status: 403 });
  if (
    submittedCsrfToken === null ||
    !(await secretsEqual(submittedCsrfToken, session.csrfToken))
  ) {
    return new Response(null, { status: 403 });
  }

  return session;
}

export async function secretsEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  if (leftDigest.byteLength !== rightDigest.byteLength) return false;

  let difference = 0;
  for (let index = 0; index < leftDigest.byteLength; index += 1) {
    const leftByte = leftDigest[index];
    const rightByte = rightDigest[index];
    if (leftByte === undefined || rightByte === undefined) return false;
    difference |= leftByte ^ rightByte;
  }
  return difference === 0;
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function randomToken(): string {
  const value = new Uint8Array(32);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
