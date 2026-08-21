import { revokeAllMcpConnections } from "../routes/mcp-oauth";
import { runtimeThumbnailBindings, thumbnailStore } from "../adapters/thumbnail-store";

const DEFAULT_WORKERS_AI_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Vectorize accepts a bounded id list per call. */
const VECTOR_DELETE_CHUNK = 500;

/**
 * Reset used to clear D1 and KV but leave the Vectorize index untouched, so
 * every vector outlived the bookmark it described. Those orphans keep matching
 * queries and, because retrieval is top-K, they crowd out the live library —
 * semantic search silently returns ids that no longer join to any row.
 */
async function forgetBookmarkVectors(env: Env, bookmarkIds: string[]): Promise<void> {
  if (!("VECTORS" in env) || bookmarkIds.length === 0) return;
  for (let start = 0; start < bookmarkIds.length; start += VECTOR_DELETE_CHUNK) {
    const chunk = bookmarkIds.slice(start, start + VECTOR_DELETE_CHUNK);
    // A failure here must not block the reset; the backlog re-embeds survivors.
    await env.VECTORS.deleteByIds(chunk).catch(() => undefined);
  }
}

/** Resets application for application reset. */
export async function resetApplication(
  env: Env,
  currentSessionIdHash: string,
  origin: string,
): Promise<void> {
  const now = new Date().toISOString();
  // Read the ids while the rows still exist.
  const embedded = await env.DB
    .prepare("SELECT id FROM bookmarks")
    .all<{ id: string }>();
  await revokeAllMcpConnections(env, origin);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_sessions"),
    env.DB.prepare("DELETE FROM bookmarks"),
    env.DB.prepare("DELETE FROM tags"),
    env.DB.prepare("DELETE FROM profile"),
    env.DB.prepare("DELETE FROM encrypted_credentials"),
    env.DB.prepare("DELETE FROM provider_candidates"),
    env.DB.prepare("DELETE FROM capture_credentials"),
    env.DB.prepare("DELETE FROM mcp_connections"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM sessions WHERE id_hash != ?").bind(currentSessionIdHash),
    env.DB
      .prepare(
        `UPDATE provider_settings
            SET provider = 'workers-ai',
                model = ?,
                operational_status = 'ready',
                last_safe_error_code = NULL,
                updated_at = ?
          WHERE id = 1`,
      )
      .bind(DEFAULT_WORKERS_AI_MODEL, now),
    env.DB
      .prepare(
        `UPDATE app_state
            SET setup_status = 'setup_incomplete',
                setup_completed_at = NULL,
                owner_ai_paused = 0,
                owner_pause_reason = NULL,
                organization_generation = organization_generation + 1,
                updated_at = ?
          WHERE id = 1`,
      )
      .bind(now),
  ]);
  await forgetBookmarkVectors(env, embedded.results.map((row) => row.id));
  await env.BACKGROUND_QUEUE.send({ type: "reset_storage" });
}

/** Processes reset storage for application reset. */
export async function processResetStorage(
  env: Env,
): Promise<"complete" | "continued"> {
  const bindings = runtimeThumbnailBindings(env);
  const stores = [
    ...(bindings.kv === undefined ? [] : [thumbnailStore("kv", bindings)]),
    ...(bindings.r2 === undefined ? [] : [thumbnailStore("r2", bindings)]),
  ];
  let hasMore = false;
  for (const store of stores) {
    const page = await store.list("thumbnails/");
    await Promise.all(page.keys.map(async (key) => {
      await store.delete(key);
    }));
    hasMore ||= page.cursor !== null;
  }
  if (hasMore) {
    await env.BACKGROUND_QUEUE.send({ type: "reset_storage" });
    return "continued";
  }
  return "complete";
}
