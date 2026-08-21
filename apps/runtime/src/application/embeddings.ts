import { z } from "zod";
import { aiGatewayOptions } from "../adapters/organization-providers";

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
// bge retrieval works asymmetrically: queries carry an instruction prefix,
// documents do not. Scores are gated relative to the best match with an
// absolute floor because cosine scores compress on short queries.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const MIN_SEMANTIC_SCORE = 0.3;
const RELATIVE_SCORE_FACTOR = 0.85;
const SEMANTIC_TOP_K = 15;
const BACKLOG_BATCH_SIZE = 10;

const embeddingResponseSchema = z.looseObject({
  data: z.array(z.array(z.number()).min(1)).min(1),
});

interface EmbeddableBookmark {
  id: string;
  revision: number;
  title: string;
  description: string | null;
  note: string | null;
  hostname: string;
  folder_name: string;
  tag_names: string | null;
}

/** Returns whether the deployment exposes the Vectorize binding. */
function vectorsAvailable(env: Env): boolean {
  return "VECTORS" in env && "AI" in env;
}

/**
 * Embedding is the call that runs on every save and every search, so it is the
 * first thing to fail when the free allocation is spent — which silently turns
 * semantic search into keyword search. Routing it through the gateway is what
 * lets prepaid credits cover it.
 */
async function aiGatewayId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT ai_gateway_id FROM provider_settings WHERE id = 1")
    .first<{ ai_gateway_id: string | null }>();
  return row?.ai_gateway_id ?? null;
}

/** Produces one validated embedding through the configured Workers AI model. */
async function embedText(env: Env, input: string): Promise<number[]> {
  const ai = env.AI as unknown as {
    run: (model: string, options: unknown, extra?: unknown) => Promise<unknown>;
  };
  const raw = await ai.run(
    EMBEDDING_MODEL,
    { text: [input.slice(0, 4000)] },
    aiGatewayOptions(await aiGatewayId(env.DB)),
  );
  const parsed = embeddingResponseSchema.safeParse(raw);
  const values = parsed.success ? parsed.data.data[0] : undefined;
  if (values === undefined) throw new Error("embedding_response_invalid");
  return values;
}

/** Builds the canonical searchable text for one bookmark embedding. */
function bookmarkEmbeddingText(bookmark: EmbeddableBookmark): string {
  return [
    bookmark.title,
    bookmark.description ?? "",
    bookmark.note ?? "",
    (bookmark.tag_names ?? "").replaceAll(",", " ").replaceAll("-", " "),
    bookmark.folder_name,
    bookmark.hostname,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * Embeds one bookmark and upserts it into Vectorize, then records the
 * embedded revision so the backlog query can find stale bookmarks.
 */
export async function upsertBookmarkVector(env: Env, bookmarkId: string): Promise<void> {
  if (!vectorsAvailable(env)) return;
  const bookmark = await env.DB
    .prepare(
      `SELECT b.id, b.revision, b.title, b.description, b.note, b.hostname,
              f.name AS folder_name,
              (
                SELECT GROUP_CONCAT(t.display_name, ',')
                  FROM bookmark_tags bt
                  JOIN tags t ON t.id = bt.tag_id
                 WHERE bt.bookmark_id = b.id AND t.status = 'active'
              ) AS tag_names
         FROM bookmarks b
         JOIN folders f ON f.id = b.folder_id
        WHERE b.id = ? AND b.deleted_at IS NULL`,
    )
    .bind(bookmarkId)
    .first<EmbeddableBookmark>();
  if (bookmark === null) return;
  const values = await embedText(env, bookmarkEmbeddingText(bookmark));
  await env.VECTORS.upsert([{ id: bookmark.id, values }]);
  await env.DB
    .prepare("UPDATE bookmarks SET embedded_revision = ? WHERE id = ? AND revision = ?")
    .bind(bookmark.revision, bookmark.id, bookmark.revision)
    .run();
}

/** Deletes bookmark vectors for semantic search. */
export async function deleteBookmarkVectors(env: Env, bookmarkIds: string[]): Promise<void> {
  if (!vectorsAvailable(env) || bookmarkIds.length === 0) return;
  await env.VECTORS.deleteByIds(bookmarkIds);
}

/**
 * Embeds up to one batch of bookmarks whose content changed since their last
 * embedding. Returns true when more stale bookmarks remain.
 */
export async function processEmbedBacklog(env: Env): Promise<boolean> {
  if (!vectorsAvailable(env)) return false;
  const stale = await env.DB
    .prepare(
      `SELECT id
         FROM bookmarks
        WHERE deleted_at IS NULL AND embedded_revision != revision
        ORDER BY modified_at DESC
        LIMIT ?`,
    )
    .bind(BACKLOG_BATCH_SIZE + 1)
    .all<{ id: string }>();
  for (const bookmark of stale.results.slice(0, BACKLOG_BATCH_SIZE)) {
    try {
      await upsertBookmarkVector(env, bookmark.id);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "embed_backlog_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message.slice(0, 200) : "",
        }),
      );
      return false;
    }
  }
  return stale.results.length > BACKLOG_BATCH_SIZE;
}

/** Returns whether any live bookmark revision still needs embedding. */
export async function hasEmbedBacklog(env: Env): Promise<boolean> {
  if (!vectorsAvailable(env)) return false;
  const stale = await env.DB
    .prepare(
      `SELECT 1 FROM bookmarks
        WHERE deleted_at IS NULL AND embedded_revision != revision
        LIMIT 1`,
    )
    .first();
  return stale !== null;
}

/**
 * Returns bookmark IDs semantically similar to the query so short searches
 * like "ml" also surface "machine learning" bookmarks. Returns null when
 * semantic search is unavailable so callers fall back to FTS alone.
 */
export async function semanticBookmarkIds(env: Env, query: string): Promise<string[] | null> {
  if (!vectorsAvailable(env) || query.trim().length === 0) return null;
  try {
    const values = await embedText(env, QUERY_PREFIX + query.trim());
    const result = await env.VECTORS.query(values, {
      topK: SEMANTIC_TOP_K,
      returnValues: false,
      returnMetadata: "none",
    });
    const topScore = result.matches[0]?.score ?? 0;
    const threshold = Math.max(MIN_SEMANTIC_SCORE, topScore * RELATIVE_SCORE_FACTOR);
    return result.matches
      .filter((match) => match.score >= threshold)
      .map((match) => match.id);
  } catch {
    return null;
  }
}
