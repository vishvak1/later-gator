import type {
  BookmarkListQuery,
  CompleteSetupInput,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "../domain/schemas";
import { UNSORTED_FOLDER_ID } from "../domain/folders";
import { importHoldsAi } from "../domain/import-state";
import { normalizeTagName } from "../domain/tags";
import { normalizeBookmarkUrl } from "../domain/url";
import { z } from "zod";

interface AppStateRow {
  setup_status: "setup_incomplete" | "ready";
  owner_ai_paused: number;
  organization_generation: number;
}

interface ProviderRow {
  provider: "workers-ai" | "openai" | "anthropic";
  model: string;
  operational_status: "ready" | "waiting";
}

export interface BookmarkRow {
  id: string;
  url: string;
  normalized_url: string;
  hostname: string;
  title: string;
  description: string | null;
  note: string | null;
  folder_id: string;
  folder_name: string;
  favorite: number;
  source_type: string;
  organization_policy: string;
  ai_state: string;
  source_created_at: string;
  added_at: string;
  modified_at: string;
  deleted_at: string | null;
  revision: number;
  thumbnail_id: string | null;
  thumbnail_width: number | null;
  thumbnail_height: number | null;
  tag_names: string | null;
}

export interface CreatedBookmark {
  bookmark: BookmarkRow;
  created: boolean;
  jobId: string | null;
  thumbnailJobId: string | null;
}

async function getAppState(db: D1Database): Promise<AppStateRow> {
  const state = await db
    .prepare(
      `SELECT setup_status, owner_ai_paused, organization_generation
         FROM app_state
        WHERE id = 1`,
    )
    .first<AppStateRow>();
  if (state === null) throw new Error("missing_app_state");
  return state;
}

async function getProvider(db: D1Database): Promise<ProviderRow> {
  const provider = await db
    .prepare(
      "SELECT provider, model, operational_status FROM provider_settings WHERE id = 1",
    )
    .first<ProviderRow>();
  if (provider === null) throw new Error("missing_provider_settings");
  return provider;
}

export async function getBookmark(db: D1Database, id: string): Promise<BookmarkRow | null> {
  return db
    .prepare(
      `SELECT b.*, f.name AS folder_name,
              t.width AS thumbnail_width, t.height AS thumbnail_height
         FROM bookmarks b
         JOIN folders f ON f.id = b.folder_id
         LEFT JOIN thumbnails t ON t.id = b.thumbnail_id AND t.state = 'ready'
        WHERE b.id = ?`,
    )
    .bind(id)
    .first<BookmarkRow>();
}

export async function completeSetup(
  db: D1Database,
  input: CompleteSetupInput,
): Promise<void> {
  const now = new Date().toISOString();
  const uniqueTags = new Map(
    input.relevantTags.flatMap((tag) => {
      const normalized = normalizeTagName(tag);
      return normalized.normalized === ""
        ? []
        : [[normalized.normalized, normalized] as const];
    }),
  );
  if (uniqueTags.size < 5) throw new Error("not_enough_distinct_tags");

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO profile (
          id, career_context, aspiration_context, personal_instructions, timezone,
          created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          career_context = excluded.career_context,
          aspiration_context = excluded.aspiration_context,
          personal_instructions = excluded.personal_instructions,
          timezone = excluded.timezone,
          updated_at = excluded.updated_at`,
      )
      .bind(
        input.careerContext,
        input.aspirationContext,
        input.personalInstructions ?? null,
        input.timezone,
        now,
        now,
      ),
  ];

  for (const tag of uniqueTags.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO tags (
            id, normalized_name, display_name, status, created_by, usage_count, created_at
          ) VALUES (?, ?, ?, 'active', 'seed', 0, ?)
          ON CONFLICT(normalized_name) DO UPDATE SET
            display_name = excluded.display_name,
            status = 'active',
            retired_at = NULL`,
        )
        .bind(crypto.randomUUID(), tag.normalized, tag.display, now),
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE app_state
            SET setup_status = 'ready',
                setup_completed_at = COALESCE(setup_completed_at, ?),
                updated_at = ?
          WHERE id = 1`,
      )
      .bind(now, now),
  );
  await db.batch(statements);
}

export async function updatePersonalInstructions(
  db: D1Database,
  personalInstructions: string | null,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE profile
          SET personal_instructions = ?, updated_at = ?
        WHERE id = 1`,
    )
    .bind(personalInstructions === "" ? null : personalInstructions, new Date().toISOString())
    .run();
  if (result.meta.changes !== 1) throw new Error("profile_not_configured");
}

export async function createBookmark(
  db: D1Database,
  input: CreateBookmarkInput,
  sourceType: "dashboard" | "extension" | "ios" | "raindrop_csv" | "linked",
  metadata?: {
    sourceCreatedAt?: string;
    deferOrganization?: boolean;
    jobIdempotencyKey?: string;
  },
): Promise<CreatedBookmark> {
  const normalized = normalizeBookmarkUrl(input.url);
  const existing = await db
    .prepare(
      `SELECT b.*, f.name AS folder_name
         FROM bookmarks b
         JOIN folders f ON f.id = b.folder_id
        WHERE b.normalized_url = ? AND b.deleted_at IS NULL`,
    )
    .bind(normalized.normalizedUrl)
    .first<BookmarkRow>();
  if (existing !== null) {
    return { bookmark: existing, created: false, jobId: null, thumbnailJobId: null };
  }

  const appState = await getAppState(db);
  const provider = await getProvider(db);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const folderId = input.folderId ?? UNSORTED_FOLDER_ID;
  const organizationPolicy =
    folderId === UNSORTED_FOLDER_ID
      ? input.organizationPolicy === "preserve" ? "preserve" : "full"
      : "none";
  const jobId = organizationPolicy === "none" ? null : crypto.randomUUID();
  const aiState =
    organizationPolicy === "none"
      ? "complete"
      : metadata?.deferOrganization === true || appState.owner_ai_paused === 1
        ? "paused_owner"
        : provider.operational_status === "waiting"
            ? "waiting_provider"
            : "pending";
  const jobState =
    metadata?.deferOrganization === true || appState.owner_ai_paused === 1
      ? "paused_owner"
      : provider.operational_status === "waiting"
          ? "waiting_provider"
          : "pending_dispatch";
  const suppliedTitle = input.title?.trim();
  const title =
    suppliedTitle === undefined || suppliedTitle.length === 0
      ? normalized.hostname
      : suppliedTitle;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO bookmarks (
          id, url, normalized_url, hostname, title, description, note, folder_id, favorite,
          source_type, organization_policy, ai_state, source_created_at, added_at,
          modified_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(
        id,
        normalized.url,
        normalized.normalizedUrl,
        normalized.hostname,
        title,
        input.description ?? null,
        input.note ?? null,
        folderId,
        input.favorite === true ? 1 : 0,
        sourceType,
        organizationPolicy,
        aiState,
        metadata?.sourceCreatedAt ?? now,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO thumbnail_jobs (
          id, bookmark_id, state, created_at, updated_at
        ) VALUES (?, ?, 'pending_dispatch', ?, ?)`,
      )
      .bind(id, id, now, now),
  ];

  if (jobId !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO background_jobs (
            id, bookmark_id, state, expected_revision, organization_generation,
            provider, model, idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          jobId,
          id,
          jobState,
          appState.organization_generation,
          provider.provider,
          provider.model,
          metadata?.jobIdempotencyKey ?? `bookmark:${id}:revision:1`,
          now,
          now,
        ),
    );
  }

  for (const rawTag of new Set(input.tags ?? [])) {
    const tag = normalizeTagName(rawTag);
    if (tag.normalized === "") continue;
    const existingTag = await db
      .prepare("SELECT id, status FROM tags WHERE normalized_name = ?")
      .bind(tag.normalized)
      .first<{ id: string; status: "active" | "retired" }>();
    if (existingTag?.status === "retired") continue;
    const tagId = existingTag?.id ?? crypto.randomUUID();
    if (existingTag === null) {
      statements.push(
        db
          .prepare(
            `INSERT INTO tags (
              id, normalized_name, display_name, status, created_by, usage_count, created_at
            ) VALUES (?, ?, ?, 'active', 'user', 0, ?)`,
          )
          .bind(tagId, tag.normalized, tag.display, now),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, created_at)
           VALUES (?, ?, 'user', ?)`,
        )
        .bind(id, tagId, now),
      db
        .prepare("UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?")
        .bind(tagId),
    );
  }

  await db.batch(statements);
  const bookmark = await getBookmark(db, id);
  if (bookmark === null) throw new Error("bookmark_commit_missing");
  return { bookmark, created: true, jobId, thumbnailJobId: id };
}

const SORT_COLUMNS = {
  added_at: "b.added_at",
  modified_at: "b.modified_at",
  source_created_at: "b.source_created_at",
  hostname: "b.hostname",
  title: "b.title",
} as const;

const bookmarkCursorSchema = z.strictObject({
  sort: z.enum(["added_at", "modified_at", "source_created_at", "hostname", "title"]),
  direction: z.enum(["asc", "desc"]),
  value: z.string(),
  id: z.uuid(),
});

export interface BookmarkPage {
  bookmarks: BookmarkRow[];
  total: number;
  nextCursor: string | null;
}

function encodeBookmarkCursor(
  sort: BookmarkListQuery["sort"],
  direction: BookmarkListQuery["direction"],
  bookmark: BookmarkRow,
): string {
  const value = bookmark[sort];
  const json = JSON.stringify({ sort, direction, value, id: bookmark.id });
  const binary = Array.from(
    new TextEncoder().encode(json),
    (byte) => String.fromCharCode(byte),
  ).join("");
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBookmarkCursor(
  encoded: string,
  query: BookmarkListQuery,
): z.infer<typeof bookmarkCursorSchema> | null {
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = bookmarkCursorSchema.safeParse(JSON.parse(json) as unknown);
    if (
      !parsed.success ||
      parsed.data.sort !== query.sort ||
      parsed.data.direction !== query.direction
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export async function listBookmarkPage(
  db: D1Database,
  query: BookmarkListQuery,
  semanticIds?: string[] | null,
): Promise<BookmarkPage> {
  const predicates: string[] = [];
  const bindings: unknown[] = [];

  predicates.push(query.includeTrash === "true" ? "b.deleted_at IS NOT NULL" : "b.deleted_at IS NULL");
  if (query.folder !== undefined) {
    predicates.push("(b.folder_id = ? OR f.slug = ?)");
    bindings.push(query.folder, query.folder);
  }
  if (query.tag !== undefined) {
    predicates.push(
      "EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND t.normalized_name = ? AND t.status = 'active')",
    );
    bindings.push(normalizeTagName(query.tag).normalized);
  }
  if (query.tags !== undefined && query.tags !== "") {
    const requestedTags = [...new Set(query.tags.split(",").map((tag) => tag.trim()).filter(Boolean))]
      .slice(0, 10);
    for (const requestedTag of requestedTags) {
      predicates.push(
        "EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND t.normalized_name = ? AND t.status = 'active')",
      );
      bindings.push(normalizeTagName(requestedTag).normalized);
    }
  }
  if (query.favorite !== undefined) {
    predicates.push("b.favorite = ?");
    bindings.push(query.favorite === "true" ? 1 : 0);
  }
  if (query.aiState !== undefined) {
    predicates.push("b.ai_state = ?");
    bindings.push(query.aiState);
  }
  if (query.hostname !== undefined) {
    predicates.push("b.hostname LIKE ? ESCAPE '\\'");
    bindings.push(
      `%${query.hostname
        .toLocaleLowerCase("en-US")
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_")}%`,
    );
  }
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    const dateColumn = query.dateField ?? "added_at";
    if (query.dateFrom !== undefined) {
      predicates.push(`b.${dateColumn} >= ?`);
      bindings.push(query.dateFrom);
    }
    if (query.dateTo !== undefined) {
      predicates.push(`b.${dateColumn} <= ?`);
      bindings.push(query.dateTo);
    }
  }
  if (query.q !== undefined && query.q !== "") {
    const terms = query.q.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
    const textClauses: string[] = [];
    if (terms.length > 0) {
      textClauses.push(
        "b.id IN (SELECT bookmark_id FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)",
      );
      bindings.push(terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND "));
      // Tags are not in the FTS index; "machine learning" must still match a
      // bookmark tagged machine-learning.
      textClauses.push(
        `(${terms
          .map(
            () =>
              "EXISTS (SELECT 1 FROM bookmark_tags qbt JOIN tags qt ON qt.id = qbt.tag_id WHERE qbt.bookmark_id = b.id AND qt.status = 'active' AND qt.normalized_name LIKE ? ESCAPE '\\')",
          )
          .join(" AND ")})`,
      );
      for (const term of terms) {
        bindings.push(
          `%${term
            .toLocaleLowerCase("en-US")
            .replaceAll("\\", "\\\\")
            .replaceAll("%", "\\%")
            .replaceAll("_", "\\_")}%`,
        );
      }
    }
    if (semanticIds !== null && semanticIds !== undefined && semanticIds.length > 0) {
      textClauses.push("b.id IN (SELECT value FROM json_each(?))");
      bindings.push(JSON.stringify(semanticIds.slice(0, 50)));
    }
    if (textClauses.length > 0) predicates.push(`(${textClauses.join(" OR ")})`);
  }

  const sortColumn = SORT_COLUMNS[query.sort];
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const countPredicates = [...predicates];
  const countBindings = [...bindings];
  if (query.cursor !== undefined) {
    const cursor = decodeBookmarkCursor(query.cursor, query);
    if (cursor === null) throw new Error("invalid_bookmark_cursor");
    const comparison = query.direction === "asc" ? ">" : "<";
    predicates.push(
      `(${sortColumn} ${comparison} ? OR (${sortColumn} = ? AND b.id ${comparison} ?))`,
    );
    bindings.push(cursor.value, cursor.value, cursor.id);
  }
  const batchResults = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS total
           FROM bookmarks b
           JOIN folders f ON f.id = b.folder_id
          WHERE ${countPredicates.join(" AND ")}`,
      )
      .bind(...countBindings),
    db
      .prepare(
    `SELECT b.*, f.name AS folder_name,
            t.width AS thumbnail_width, t.height AS thumbnail_height,
            (
              SELECT GROUP_CONCAT(active_tag.display_name, ',')
                FROM bookmark_tags active_bt
                JOIN tags active_tag ON active_tag.id = active_bt.tag_id
               WHERE active_bt.bookmark_id = b.id AND active_tag.status = 'active'
            ) AS tag_names
       FROM bookmarks b
       JOIN folders f ON f.id = b.folder_id
       LEFT JOIN thumbnails t ON t.id = b.thumbnail_id AND t.state = 'ready'
      WHERE ${predicates.join(" AND ")}
      ORDER BY ${sortColumn} ${direction}, b.id ${direction}
      LIMIT ?`,
      )
      .bind(...bindings, query.limit + 1),
  ]);
  const countResult = batchResults[0];
  const pageResult = batchResults[1];
  if (countResult === undefined || pageResult === undefined) {
    throw new Error("bookmark_page_query_failed");
  }
  const totalRow = countResult.results[0] as { total?: number } | undefined;
  const rows = pageResult.results as unknown as BookmarkRow[];
  const hasNextPage = rows.length > query.limit;
  const bookmarks = hasNextPage ? rows.slice(0, query.limit) : rows;
  const lastBookmark = bookmarks.at(-1);
  return {
    bookmarks,
    total: totalRow?.total ?? 0,
    nextCursor:
      hasNextPage && lastBookmark !== undefined
        ? encodeBookmarkCursor(query.sort, query.direction, lastBookmark)
        : null,
  };
}

export async function listBookmarks(
  db: D1Database,
  query: BookmarkListQuery,
  semanticIds?: string[] | null,
): Promise<BookmarkRow[]> {
  return (await listBookmarkPage(db, query, semanticIds)).bookmarks;
}

export async function updateBookmark(
  db: D1Database,
  id: string,
  input: UpdateBookmarkInput,
): Promise<BookmarkRow | "revision_conflict" | null> {
  const current = await getBookmark(db, id);
  if (current === null) return null;
  if (current.revision !== input.expectedRevision) return "revision_conflict";

  const normalized = input.url === undefined ? null : normalizeBookmarkUrl(input.url);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE bookmarks
          SET url = COALESCE(?, url),
              normalized_url = COALESCE(?, normalized_url),
              hostname = COALESCE(?, hostname),
              title = COALESCE(?, title),
              description = CASE WHEN ? = 1 THEN ? ELSE description END,
              note = CASE WHEN ? = 1 THEN ? ELSE note END,
              organization_policy = CASE
                WHEN ? IS NULL THEN organization_policy
                WHEN ? = 'folder_unsorted' AND folder_id != 'folder_unsorted' THEN 'full'
                WHEN ? != 'folder_unsorted' THEN 'none'
                ELSE organization_policy
              END,
              ai_state = CASE
                WHEN ? IS NULL THEN ai_state
                WHEN ? = 'folder_unsorted' AND folder_id != 'folder_unsorted' THEN 'pending'
                WHEN ? != 'folder_unsorted' THEN 'complete'
                ELSE ai_state
              END,
              folder_id = COALESCE(?, folder_id),
              favorite = COALESCE(?, favorite),
              modified_at = ?,
              revision = revision + 1
        WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    ).bind(
      normalized?.url ?? null,
      normalized?.normalizedUrl ?? null,
      normalized?.hostname ?? null,
      input.title ?? null,
      input.description !== undefined ? 1 : 0,
      input.description ?? null,
      input.note !== undefined ? 1 : 0,
      input.note ?? null,
      input.folderId ?? null,
      input.folderId ?? null,
      input.folderId ?? null,
      input.folderId ?? null,
      input.folderId ?? null,
      input.folderId ?? null,
      input.folderId ?? null,
      input.favorite === undefined ? null : input.favorite ? 1 : 0,
      now,
      id,
      input.expectedRevision,
    ),
  ];

  if (input.folderId !== undefined && input.folderId !== UNSORTED_FOLDER_ID) {
    statements.push(
      db
        .prepare(
          `UPDATE background_jobs
              SET state = 'cancelled',
                  last_safe_error_code = 'bookmark_left_unsorted',
                  completed_at = ?,
                  updated_at = ?
            WHERE bookmark_id = ?
              AND state IN ('pending_dispatch', 'queued', 'running', 'waiting_provider', 'paused_edit', 'paused_owner')
              AND EXISTS (
                SELECT 1 FROM bookmarks
                 WHERE id = ? AND revision = ? AND modified_at = ?
              )`,
        )
        .bind(now, now, id, id, input.expectedRevision + 1, now),
    );
  }

  if (input.tags !== undefined) {
    const requestedTags = new Map(
      input.tags.flatMap((rawTag) => {
        const tag = normalizeTagName(rawTag);
        return tag.normalized === "" ? [] : [[tag.normalized, tag] as const];
      }),
    );
    const existingTags = await db
      .prepare(
        `SELECT id, normalized_name, status
           FROM tags
          WHERE normalized_name IN (${[...requestedTags].map(() => "?").join(", ") || "NULL"})`,
      )
      .bind(...requestedTags.keys())
      .all<{ id: string; normalized_name: string; status: "active" | "retired" }>();
    if (existingTags.results.some((tag) => tag.status === "retired")) {
      throw new Error("retired_tag_requires_restore");
    }

    const tagIds = new Map(existingTags.results.map((tag) => [tag.normalized_name, tag.id]));
    for (const [normalizedName, tag] of requestedTags) {
      if (!tagIds.has(normalizedName)) {
        const tagId = crypto.randomUUID();
        tagIds.set(normalizedName, tagId);
        statements.push(
          db
            .prepare(
              `INSERT INTO tags (
                id, normalized_name, display_name, status, created_by, usage_count, created_at
              )
              SELECT ?, ?, ?, 'active', 'user', 0, ?
               WHERE EXISTS (
                 SELECT 1 FROM bookmarks
                  WHERE id = ? AND revision = ? AND modified_at = ?
               )`,
            )
            .bind(
              tagId,
              tag.normalized,
              tag.display,
              now,
              id,
              input.expectedRevision + 1,
              now,
            ),
        );
      }
    }
    statements.push(
      db
        .prepare(
          `DELETE FROM bookmark_tags
            WHERE bookmark_id = ?
              AND EXISTS (
                SELECT 1 FROM bookmarks
                 WHERE id = ? AND revision = ? AND modified_at = ?
              )`,
        )
        .bind(id, id, input.expectedRevision + 1, now),
    );
    for (const tagId of tagIds.values()) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, created_at)
             SELECT ?, ?, 'user', ?
              WHERE EXISTS (
                SELECT 1 FROM bookmarks
                 WHERE id = ? AND revision = ? AND modified_at = ?
              )`,
          )
          .bind(id, tagId, now, id, input.expectedRevision + 1, now),
      );
    }
    statements.push(
      db.prepare(
        `UPDATE tags
            SET usage_count = (
              SELECT COUNT(*) FROM bookmark_tags WHERE bookmark_tags.tag_id = tags.id
            )`,
      ),
    );
  }

  if (normalized !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE thumbnails
              SET state = 'stale', updated_at = ?
            WHERE bookmark_id = ?
              AND source_type != 'user'
              AND EXISTS (
                SELECT 1 FROM bookmarks
                 WHERE id = ? AND revision = ? AND modified_at = ?
              )`,
        )
        .bind(now, id, id, input.expectedRevision + 1, now),
      db
        .prepare(
          `UPDATE bookmarks
              SET thumbnail_id = NULL
            WHERE id = ? AND revision = ? AND modified_at = ?
              AND EXISTS (
                SELECT 1 FROM thumbnails
                 WHERE bookmark_id = ? AND source_type != 'user'
              )`,
        )
        .bind(id, input.expectedRevision + 1, now, id),
      db
        .prepare(
          `INSERT INTO thumbnail_jobs (
             id, bookmark_id, state, attempt_count, created_at, updated_at
           )
           SELECT ?, ?, 'pending_dispatch', 0, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM bookmarks
               WHERE id = ? AND revision = ? AND modified_at = ?
            )
              AND NOT EXISTS (
                SELECT 1 FROM thumbnails
                 WHERE bookmark_id = ? AND source_type = 'user'
              )
           ON CONFLICT(bookmark_id) DO UPDATE SET
             state = 'pending_dispatch',
             attempt_count = 0,
             next_attempt_at = NULL,
             last_safe_error_code = NULL,
             updated_at = excluded.updated_at,
             completed_at = NULL`,
        )
        .bind(
          id,
          id,
          now,
          now,
          id,
          input.expectedRevision + 1,
          now,
          id,
        ),
    );
  }

  await db.batch(statements);
  const updated = await getBookmark(db, id);
  if (
    updated?.revision !== input.expectedRevision + 1 ||
    updated.modified_at !== now
  ) {
    return "revision_conflict";
  }
  return updated;
}

export async function setBookmarkDeleted(
  db: D1Database,
  id: string,
  deleted: boolean,
): Promise<BookmarkRow | null> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE bookmarks
          SET deleted_at = ?, modified_at = ?, revision = revision + 1
        WHERE id = ? AND ${deleted ? "deleted_at IS NULL" : "deleted_at IS NOT NULL"}`,
    )
    .bind(deleted ? now : null, now, id)
    .run();
  if (result.meta.changes !== 1) return null;
  return getBookmark(db, id);
}

export async function dispatchJob(
  db: D1Database,
  queue: Queue,
  jobId: string,
): Promise<boolean> {
  if (await importHoldsAi(db)) return true;
  try {
    await queue.send({ version: 1, jobId });
    await db
      .prepare(
        `UPDATE background_jobs
            SET state = 'queued', updated_at = ?
          WHERE id = ? AND state = 'pending_dispatch'`,
      )
      .bind(new Date().toISOString(), jobId)
      .run();
    return true;
  } catch {
    return false;
  }
}

async function canonicalizeStoredTags(db: D1Database): Promise<void> {
  const stored = await db
    .prepare(
      `SELECT id, normalized_name, display_name, status
         FROM tags
        ORDER BY status, created_at, id`,
    )
    .all<{
      id: string;
      normalized_name: string;
      display_name: string;
      status: "active" | "retired";
    }>();
  const groups = new Map<string, typeof stored.results>();
  const invalidIds: string[] = [];
  for (const tag of stored.results) {
    const canonical = normalizeTagName(tag.display_name).normalized;
    if (canonical === "") {
      invalidIds.push(tag.id);
      continue;
    }
    const group = groups.get(canonical) ?? [];
    group.push(tag);
    groups.set(canonical, group);
  }

  const targets: { id: string; name: string }[] = [];
  const merges: { sourceId: string; targetId: string }[] = [];
  for (const [name, tags] of groups) {
    const target = tags.find((tag) => tag.status === "active") ?? tags[0];
    if (target === undefined) continue;
    targets.push({ id: target.id, name });
    for (const tag of tags) {
      if (tag.id !== target.id) merges.push({ sourceId: tag.id, targetId: target.id });
    }
  }
  const needsMigration =
    merges.length > 0 ||
    invalidIds.length > 0 ||
    targets.some((target) => {
      const storedTarget = stored.results.find((tag) => tag.id === target.id);
      return (
        storedTarget?.normalized_name !== target.name ||
        storedTarget.display_name !== target.name
      );
    });
  if (!needsMigration) return;

  const statements: D1PreparedStatement[] = [];
  if (merges.length > 0) {
    const payload = JSON.stringify(merges);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, created_at)
           SELECT bt.bookmark_id,
                  json_extract(j.value, '$.targetId'),
                  bt.source,
                  bt.created_at
             FROM json_each(?) j
             JOIN bookmark_tags bt
               ON bt.tag_id = json_extract(j.value, '$.sourceId')`,
        )
        .bind(payload),
      db
        .prepare(
          `DELETE FROM bookmark_tags
            WHERE tag_id IN (
              SELECT json_extract(value, '$.sourceId') FROM json_each(?)
            )`,
        )
        .bind(payload),
      db
        .prepare(
          `DELETE FROM tags
            WHERE id IN (
              SELECT json_extract(value, '$.sourceId') FROM json_each(?)
            )`,
        )
        .bind(payload),
    );
  }
  if (invalidIds.length > 0) {
    const payload = JSON.stringify(invalidIds);
    statements.push(
      db
        .prepare("DELETE FROM bookmark_tags WHERE tag_id IN (SELECT value FROM json_each(?))")
        .bind(payload),
      db
        .prepare("DELETE FROM tags WHERE id IN (SELECT value FROM json_each(?))")
        .bind(payload),
    );
  }
  statements.push(
    db
      .prepare(
        `WITH payload AS (
           SELECT json_extract(value, '$.id') AS id,
                  json_extract(value, '$.name') AS name
             FROM json_each(?)
         )
         UPDATE tags
            SET normalized_name = (
                  SELECT name FROM payload WHERE payload.id = tags.id
                ),
                display_name = (
                  SELECT name FROM payload WHERE payload.id = tags.id
                )
          WHERE id IN (SELECT id FROM payload)`,
      )
      .bind(JSON.stringify(targets)),
    db.prepare(
      `UPDATE tags
          SET usage_count = (
            SELECT COUNT(*) FROM bookmark_tags WHERE bookmark_tags.tag_id = tags.id
          )`,
    ),
  );
  await db.batch(statements);
}

export async function getBootstrapState(db: D1Database): Promise<{
  setupStatus: string;
  ownerAiPaused: boolean;
  personalInstructions: string | null;
  activeImport: Record<string, unknown> | null;
  folders: D1Result<Record<string, unknown>>["results"];
  tags: D1Result<Record<string, unknown>>["results"];
  sites: string[];
  trashCount: number;
  automationProgress: {
    total: number;
    complete: number;
    pending: number;
    processing: number;
    waitingProvider: number;
    pausedOwner: number;
    review: number;
    failed: number;
    lastActivityAt: string | null;
  };
  provider: {
    provider: string;
    model: string;
    operational_status: string;
    last_safe_error_code: string | null;
  };
}> {
  await canonicalizeStoredTags(db);
  const state = await getAppState(db);
  const [folders, tags, sites, provider, profile, activeImport, trash, automationProgress] =
    await Promise.all([
    db
      .prepare(
        `SELECT f.id, f.slug, f.name, f.kind, f.sort_order, f.is_ai_destination,
                COUNT(b.id) AS bookmark_count
           FROM folders f
           LEFT JOIN bookmarks b ON b.folder_id = f.id AND b.deleted_at IS NULL
          GROUP BY f.id, f.slug, f.name, f.kind, f.sort_order, f.is_ai_destination
          ORDER BY f.sort_order`,
      )
      .all(),
    db
      .prepare(
        "SELECT id, normalized_name, display_name, status, usage_count FROM tags ORDER BY display_name",
      )
      .all(),
    db
      .prepare(
        `SELECT DISTINCT hostname
           FROM bookmarks
          WHERE deleted_at IS NULL
          ORDER BY hostname
          LIMIT 500`,
      )
      .all<{ hostname: string }>(),
    db
      .prepare(
        `SELECT provider, model, operational_status, last_safe_error_code
           FROM provider_settings WHERE id = 1`,
      )
      .first<{
        provider: string;
        model: string;
        operational_status: string;
        last_safe_error_code: string | null;
      }>(),
    db
      .prepare("SELECT personal_instructions FROM profile WHERE id = 1")
      .first<{ personal_instructions: string | null }>(),
    db
      .prepare(
        `SELECT id, status, option, file_name, total_rows, valid_rows, invalid_rows,
                duplicate_rows, committed_rows, failed_rows, created_at, expires_at,
                committed_rows + duplicate_rows + invalid_rows + failed_rows AS processed_rows
           FROM import_sessions
          WHERE status = 'committing'
            AND file_sha256 = ''
            AND expires_at > ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .bind(new Date().toISOString())
      .first(),
    db
      .prepare("SELECT COUNT(*) AS count FROM bookmarks WHERE deleted_at IS NOT NULL")
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN b.ai_state = 'complete' THEN 1 ELSE 0 END) AS complete,
           SUM(CASE WHEN b.ai_state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN b.ai_state = 'processing' THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN b.ai_state = 'waiting_provider' THEN 1 ELSE 0 END) AS waiting_provider,
           SUM(CASE WHEN b.ai_state = 'paused_owner' THEN 1 ELSE 0 END) AS paused_owner,
           SUM(CASE WHEN b.ai_state = 'review' THEN 1 ELSE 0 END) AS review,
           SUM(CASE WHEN b.ai_state = 'failed' THEN 1 ELSE 0 END) AS failed,
           (SELECT MAX(updated_at) FROM background_jobs) AS last_activity_at
         FROM bookmarks b
        WHERE b.deleted_at IS NULL
          AND b.organization_policy != 'none'`,
      )
      .first<{
        total: number;
        complete: number | null;
        pending: number | null;
        processing: number | null;
        waiting_provider: number | null;
        paused_owner: number | null;
        review: number | null;
        failed: number | null;
        last_activity_at: string | null;
      }>(),
  ]);
  if (provider === null) throw new Error("missing_provider_settings");
  return {
    setupStatus: state.setup_status,
    ownerAiPaused: state.owner_ai_paused === 1,
    personalInstructions: profile?.personal_instructions ?? null,
    activeImport,
    folders: folders.results,
    tags: tags.results,
    sites: sites.results.map((site) => site.hostname),
    trashCount: trash?.count ?? 0,
    automationProgress: {
      total: automationProgress?.total ?? 0,
      complete: automationProgress?.complete ?? 0,
      pending: automationProgress?.pending ?? 0,
      processing: automationProgress?.processing ?? 0,
      waitingProvider: automationProgress?.waiting_provider ?? 0,
      pausedOwner: automationProgress?.paused_owner ?? 0,
      review: automationProgress?.review ?? 0,
      failed: automationProgress?.failed ?? 0,
      lastActivityAt: automationProgress?.last_activity_at ?? null,
    },
    provider,
  };
}

export async function createTag(
  db: D1Database,
  rawName: string,
): Promise<{ id: string; normalizedName: string; displayName: string; created: boolean }> {
  const tag = normalizeTagName(rawName);
  if (tag.normalized === "") throw new Error("invalid_tag_name");
  const existing = await db
    .prepare("SELECT id, status, display_name FROM tags WHERE normalized_name = ?")
    .bind(tag.normalized)
    .first<{ id: string; status: "active" | "retired"; display_name: string }>();
  if (existing?.status === "retired") throw new Error("retired_tag_requires_restore");
  if (existing !== null) {
    return {
      id: existing.id,
      normalizedName: tag.normalized,
      displayName: existing.display_name,
      created: false,
    };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tags (
        id, normalized_name, display_name, status, created_by, usage_count, created_at
      ) VALUES (?, ?, ?, 'active', 'user', 0, ?)`,
    )
    .bind(id, tag.normalized, tag.display, new Date().toISOString())
    .run();
  return { id, normalizedName: tag.normalized, displayName: tag.display, created: true };
}

export async function retireTag(
  db: D1Database,
  tagId: string,
): Promise<{ retired: boolean; affectedBookmarks: number }> {
  const tag = await db
    .prepare("SELECT status FROM tags WHERE id = ?")
    .bind(tagId)
    .first<{ status: "active" | "retired" }>();
  if (tag === null || tag.status === "retired") return { retired: false, affectedBookmarks: 0 };

  const affected = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM bookmark_tags bt
         JOIN bookmarks b ON b.id = bt.bookmark_id
        WHERE bt.tag_id = ? AND b.deleted_at IS NULL`,
    )
    .bind(tagId)
    .first<{ count: number }>();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE bookmarks
            SET revision = revision + 1, modified_at = ?
          WHERE deleted_at IS NULL
            AND id IN (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = ?)`,
      )
      .bind(now, tagId),
    db.prepare("DELETE FROM bookmark_tags WHERE tag_id = ?").bind(tagId),
    db
      .prepare(
        `UPDATE tags
            SET status = 'retired', retired_at = ?, usage_count = 0
          WHERE id = ? AND status = 'active'`,
      )
      .bind(now, tagId),
  ]);
  return { retired: true, affectedBookmarks: affected?.count ?? 0 };
}

export async function setOwnerPause(
  db: D1Database,
  paused: boolean,
  reason: string | null,
): Promise<string[]> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE app_state
            SET owner_ai_paused = ?,
                owner_pause_reason = ?,
                updated_at = ?
          WHERE id = 1`,
      )
      .bind(paused ? 1 : 0, paused ? reason : null, now),
    db
      .prepare(
        paused
          ? `UPDATE background_jobs
                SET state = 'paused_owner', updated_at = ?
              WHERE state IN ('pending_dispatch', 'queued', 'paused_edit')`
          : `UPDATE background_jobs
                SET state = 'pending_dispatch',
                    updated_at = ?
              WHERE state = 'paused_owner'`,
      )
      .bind(now),
    db
      .prepare(
        paused
          ? `UPDATE bookmarks
                SET ai_state = 'paused_owner'
              WHERE ai_state IN ('pending', 'paused_edit')`
          : `UPDATE bookmarks
                SET ai_state = 'pending'
              WHERE ai_state = 'paused_owner'`,
      ),
  ]);
  if (paused) return [];
  const jobs = await db
    .prepare("SELECT id FROM background_jobs WHERE state = 'pending_dispatch' ORDER BY created_at")
    .all<{ id: string }>();
  return jobs.results.map((job) => job.id);
}

export async function relateBookmarks(
  db: D1Database,
  firstId: string,
  secondId: string,
): Promise<boolean> {
  if (firstId === secondId) return false;
  const [leftId, rightId] = [firstId, secondId].sort();
  if (leftId === undefined || rightId === undefined) return false;
  const existing = await db
    .prepare(
      `SELECT id FROM bookmark_relationships
        WHERE left_bookmark_id = ? AND right_bookmark_id = ? AND relationship_type = 'related'`,
    )
    .bind(leftId, rightId)
    .first();
  if (existing !== null) return false;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO bookmark_relationships (
          id, left_bookmark_id, right_bookmark_id, relationship_type, created_at
        ) VALUES (?, ?, ?, 'related', ?)`,
      )
      .bind(crypto.randomUUID(), leftId, rightId, now),
    db
      .prepare(
        `UPDATE bookmarks
            SET revision = revision + 1, modified_at = ?
          WHERE id IN (?, ?) AND deleted_at IS NULL`,
      )
      .bind(now, leftId, rightId),
    db
      .prepare(
        `UPDATE background_jobs
            SET expected_revision = expected_revision + 1, updated_at = ?
          WHERE bookmark_id IN (?, ?)
            AND state IN (
              'pending_dispatch', 'queued', 'waiting_provider', 'paused_edit', 'paused_owner'
            )`,
      )
      .bind(now, leftId, rightId),
  ]);
  return true;
}

export async function unrelateBookmarks(
  db: D1Database,
  firstId: string,
  secondId: string,
): Promise<boolean> {
  if (firstId === secondId) return false;
  const [leftId, rightId] = [firstId, secondId].sort();
  if (leftId === undefined || rightId === undefined) return false;
  const now = new Date().toISOString();
  const deleted = await db
    .prepare(
      `DELETE FROM bookmark_relationships
        WHERE left_bookmark_id = ? AND right_bookmark_id = ?
          AND relationship_type = 'related'`,
    )
    .bind(leftId, rightId)
    .run();
  if (deleted.meta.changes !== 1) return false;
  await db.batch([
    db
      .prepare(
        `UPDATE bookmarks
            SET revision = revision + 1, modified_at = ?
          WHERE id IN (?, ?) AND deleted_at IS NULL`,
      )
      .bind(now, leftId, rightId),
    db
      .prepare(
        `UPDATE background_jobs
            SET expected_revision = expected_revision + 1, updated_at = ?
          WHERE bookmark_id IN (?, ?)
            AND state IN (
              'pending_dispatch', 'queued', 'waiting_provider', 'paused_edit', 'paused_owner'
            )`,
      )
      .bind(now, leftId, rightId),
  ]);
  return true;
}

export async function restoreTag(db: D1Database, tagId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE tags
          SET status = 'active', retired_at = NULL
        WHERE id = ? AND status = 'retired'`,
    )
    .bind(tagId)
    .run();
  return result.meta.changes === 1;
}

export async function permanentlyDeleteBookmark(
  env: Env,
  bookmarkId: string,
): Promise<boolean> {
  const bookmark = await env.DB
    .prepare(
      `SELECT b.id, t.object_key
         FROM bookmarks b
         LEFT JOIN thumbnails t ON t.bookmark_id = b.id
        WHERE b.id = ? AND b.deleted_at IS NOT NULL`,
    )
    .bind(bookmarkId)
    .first<{ id: string; object_key: string | null }>();
  if (bookmark === null) return false;
  if (bookmark.object_key !== null) await env.THUMBNAILS.delete(bookmark.object_key);
  await env.DB.prepare("DELETE FROM bookmarks WHERE id = ? AND deleted_at IS NOT NULL").bind(bookmarkId).run();
  return true;
}

export async function getBookmarkDetails(
  db: D1Database,
  bookmarkId: string,
): Promise<object | null> {
  const bookmark = await getBookmark(db, bookmarkId);
  if (bookmark === null) return null;
  const [tags, relationships] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.display_name, t.normalized_name, bt.source
           FROM bookmark_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.bookmark_id = ? AND t.status = 'active'
          ORDER BY t.display_name`,
      )
      .bind(bookmarkId)
      .all(),
    db
      .prepare(
        `SELECT b.id, b.title, b.url, b.hostname, f.name AS folder_name
           FROM bookmark_relationships r
           JOIN bookmarks b ON b.id = CASE
             WHEN r.left_bookmark_id = ? THEN r.right_bookmark_id
             ELSE r.left_bookmark_id
           END
           JOIN folders f ON f.id = b.folder_id
          WHERE (r.left_bookmark_id = ? OR r.right_bookmark_id = ?)
            AND b.deleted_at IS NULL
          ORDER BY b.modified_at DESC
          LIMIT 50`,
      )
      .bind(bookmarkId, bookmarkId, bookmarkId)
      .all(),
  ]);
  return {
    ...bookmark,
    tags: tags.results,
    relatedBookmarks: relationships.results,
    thumbnailAvailable: bookmark.thumbnail_id !== null,
  };
}
