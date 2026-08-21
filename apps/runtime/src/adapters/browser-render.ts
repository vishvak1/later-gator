import puppeteer from "@cloudflare/puppeteer";

/** A page that has not produced text in this long will not produce any. */
const RENDER_TIMEOUT_MS = 10_000;
const MAX_RENDERED_CHARS = 4000;
const MIN_USEFUL_CHARS = 80;

export interface RenderedPage {
  title: string | null;
  text: string;
}

interface BrowserEnv {
  BROWSER?: unknown;
  DB: D1Database;
}

/**
 * A deployment without the binding behaves exactly as it did before this tier
 * existed. Everything below is skipped rather than failed.
 */
export function browserBindingPresent(env: Env): boolean {
  return "BROWSER" in (env as unknown as BrowserEnv) &&
    (env as unknown as BrowserEnv).BROWSER !== undefined;
}

/** Cloudflare meters browser time per UTC day, so the latch clears at UTC midnight. */
function nextUtcMidnight(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

/** Returns whether browser rendering is latched off until the next UTC day. */
export async function browserBudgetExhausted(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT browser_blocked_until FROM app_state WHERE id = 1")
    .first<{ browser_blocked_until: string | null }>();
  const blockedUntil = row?.browser_blocked_until ?? null;
  return blockedUntil !== null && Date.parse(blockedUntil) > Date.now();
}

/** Records the next UTC midnight after a browser allocation failure. */
async function latchBudgetExhausted(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE app_state
          SET browser_blocked_until = ?, updated_at = ?
        WHERE id = 1`,
    )
    .bind(nextUtcMidnight(), new Date().toISOString())
    .run();
}

/** Identifies browser allocation failures that should trip the daily latch. */
function isBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|browser time limit|rate limit|unable to create new browser/iu.test(message);
}

/**
 * Renders a page and returns its visible text. Every failure resolves to null:
 * the caller keeps whatever the plain fetch produced, so this tier can only
 * improve an outcome, never block one.
 */
export async function renderPageText(env: Env, rawUrl: string): Promise<RenderedPage | null> {
  if (!browserBindingPresent(env)) return null;
  if (await browserBudgetExhausted(env.DB)) return null;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    // Never keep_alive: an unclosed session bills until it times out, and one
    // leak at the maximum timeout would spend the entire daily allocation.
    browser = await puppeteer.launch((env as unknown as { BROWSER: Fetcher }).BROWSER);
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);
    await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    // Runs inside the rendered page, where the Worker's own globals do not apply.
    const rendered = await page.evaluate(() => {
      const doc = (globalThis as unknown as {
        document: { title: string; body: { innerText: string } };
      }).document;
      return { title: doc.title, text: doc.body.innerText };
    });
    const text = rendered.text.replace(/\s+/gu, " ").trim().slice(0, MAX_RENDERED_CHARS);
    if (text.length < MIN_USEFUL_CHARS) return null;
    return {
      title: rendered.title.trim().length === 0 ? null : rendered.title.trim().slice(0, 300),
      text,
    };
  } catch (error) {
    if (isBudgetError(error)) await latchBudgetExhausted(env.DB).catch(() => undefined);
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
