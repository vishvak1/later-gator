import { normalizeTagNames } from "../domain/tags";
import { normalizeBookmarkUrl } from "../domain/url";

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const IMPORT_HOURS = 24;
const INSERT_CHUNK_SIZE = 100;

interface ImportBookmark {
  id: string;
  url: string;
  normalizedUrl: string;
  hostname: string;
  title: string;
  description: string | null;
  tags: string[];
  organizationPolicy: "full" | "preserve";
}

interface ImportStatus {
  id: string;
  status: "committing" | "committed" | "cancelled";
  option: "reorganize" | "preserve";
  file_name: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  committed_rows: number;
  failed_rows: number;
  processed_rows: number;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
}

export interface StartedImport {
  status: ImportStatus;
  completion: Promise<void>;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("csv_unclosed_quote");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function splitIntoChunks<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parseTags(value: string): string[] {
  return value.trim() === "" ? [] : normalizeTagNames(value.split(/[,;]/u), 50);
}

async function markImportStopped(db: D1Database, importId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE import_sessions
          SET status = 'cancelled',
              failed_rows = MAX(0, total_rows - committed_rows - duplicate_rows - invalid_rows)
        WHERE id = ? AND status = 'committing'`,
    )
    .bind(importId)
    .run();
}

async function insertBookmarks(
  env: Env,
  importId: string,
  bookmarks: ImportBookmark[],
  importedAt: string,
): Promise<void> {
  const db = env.DB;
  try {
    const state = await db
      .prepare(
        `SELECT s.owner_ai_paused, s.organization_generation,
                p.provider, p.model, p.operational_status
           FROM app_state s
           JOIN provider_settings p ON p.id = 1
          WHERE s.id = 1`,
      )
      .first<{
        owner_ai_paused: number;
        organization_generation: number;
        provider: string;
        model: string;
        operational_status: string;
      }>();
    if (state === null) throw new Error("missing_automation_state");
    const aiState =
      state.owner_ai_paused === 1
        ? "paused_owner"
        : state.operational_status === "waiting"
          ? "waiting_provider"
          : "pending";
    const jobState =
      state.owner_ai_paused === 1
        ? "paused_owner"
        : state.operational_status === "waiting"
          ? "waiting_provider"
          : "pending_dispatch";

    for (const chunk of splitIntoChunks(bookmarks, INSERT_CHUNK_SIZE)) {
      const active = await db
        .prepare("SELECT 1 FROM import_sessions WHERE id = ? AND status = 'committing'")
        .bind(importId)
        .first();
      if (active === null) return;

      const inserted = await db
        .prepare(
          `INSERT OR IGNORE INTO bookmarks (
            id, url, normalized_url, hostname, title, description, note, folder_id,
            favorite, source_type, organization_policy, ai_state, source_created_at,
            added_at, modified_at, revision
          )
          SELECT json_extract(value, '$.id'),
                 json_extract(value, '$.url'),
                 json_extract(value, '$.normalizedUrl'),
                 json_extract(value, '$.hostname'),
                 json_extract(value, '$.title'),
                 json_extract(value, '$.description'),
                 NULL,
                 'folder_unsorted',
                 0,
                 'raindrop_csv',
                 json_extract(value, '$.organizationPolicy'),
                 ?,
                 ?,
                 ?,
                 ?,
                 1
            FROM json_each(?)
          RETURNING id`,
        )
        .bind(aiState, importedAt, importedAt, importedAt, JSON.stringify(chunk))
        .all<{ id: string }>();
      const insertedCount = inserted.results.length;
      const skippedCount = chunk.length - insertedCount;
      const insertedIds = inserted.results.map(row => row.id);
      const statements: D1PreparedStatement[] = [];
      if (insertedIds.length > 0) {
        const insertedIdSet = new Set(insertedIds);
        const insertedBookmarks = chunk.filter((bookmark) => insertedIdSet.has(bookmark.id));
        const jobRows = JSON.stringify(
          insertedIds.map(bookmarkId => ({
            id: crypto.randomUUID(),
            bookmarkId,
            idempotencyKey: `import:${importId}:${bookmarkId}`,
          })),
        );
        const insertedIdsJson = JSON.stringify(insertedIds);
        statements.push(
          db
            .prepare(
              `INSERT INTO background_jobs (
                 id, bookmark_id, state, expected_revision, organization_generation,
                 provider, model, idempotency_key, created_at, updated_at
               )
               SELECT json_extract(value, '$.id'),
                      json_extract(value, '$.bookmarkId'),
                      ?, 1, ?, ?, ?, json_extract(value, '$.idempotencyKey'), ?, ?
                 FROM json_each(?)`,
            )
            .bind(
              jobState,
              state.organization_generation,
              state.provider,
              state.model,
              importedAt,
              importedAt,
              jobRows,
            ),
          db
            .prepare(
              `INSERT INTO thumbnail_jobs (
                 id, bookmark_id, state, created_at, updated_at
               )
               SELECT value, value, 'pending_dispatch', ?, ?
                 FROM json_each(?)`,
            )
            .bind(importedAt, importedAt, insertedIdsJson),
        );
        const importedTags = new Map<string, { id: string; display: string }>();
        const bookmarkTags: { bookmarkId: string; normalizedName: string }[] = [];
        for (const bookmark of insertedBookmarks) {
          for (const normalizedName of bookmark.tags) {
            if (!importedTags.has(normalizedName)) {
              importedTags.set(normalizedName, {
                id: crypto.randomUUID(),
                display: normalizedName,
              });
            }
            bookmarkTags.push({ bookmarkId: bookmark.id, normalizedName });
          }
        }
        if (importedTags.size > 0) {
          statements.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO tags (
                   id, normalized_name, display_name, status, created_by, usage_count, created_at
                 )
                 SELECT json_extract(value, '$.id'),
                        json_extract(value, '$.normalizedName'),
                        json_extract(value, '$.display'),
                        'active', 'import', 0, ?
                   FROM json_each(?)`,
              )
              .bind(
                importedAt,
                JSON.stringify(
                  [...importedTags].map(([normalizedName, tag]) => ({
                    id: tag.id,
                    normalizedName,
                    display: tag.display,
                  })),
                ),
              ),
            db
              .prepare(
                `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, created_at)
                 SELECT json_extract(value, '$.bookmarkId'), t.id, 'import', ?
                   FROM json_each(?)
                   JOIN tags t
                     ON t.normalized_name = json_extract(value, '$.normalizedName')
                    AND t.status = 'active'`,
              )
              .bind(importedAt, JSON.stringify(bookmarkTags)),
            db.prepare(
              `UPDATE tags
                  SET usage_count = (
                    SELECT COUNT(*) FROM bookmark_tags WHERE bookmark_tags.tag_id = tags.id
                  )`,
            ),
          );
        }
      }
      statements.push(
        db
          .prepare(
            `UPDATE import_sessions
                SET committed_rows = committed_rows + ?,
                    duplicate_rows = duplicate_rows + ?
              WHERE id = ? AND status = 'committing'`,
          )
          .bind(insertedCount, skippedCount, importId),
      );
      await db.batch(statements);
    }

    await db
      .prepare(
        `UPDATE import_sessions
            SET status = 'committed', committed_at = ?
          WHERE id = ? AND status = 'committing'`,
      )
      .bind(new Date().toISOString(), importId)
      .run();
    await Promise.all([
      env.BACKGROUND_QUEUE.send({ version: 1, type: "dispatch_pending" }),
      env.THUMBNAIL_QUEUE.send({
        version: 1,
        type: "dispatch_thumbnail_pending",
      }),
    ]).catch(() => undefined);
  } catch {
    await markImportStopped(db, importId);
  }
}

export async function startRaindropCsvImport(
  env: Env,
  file: File,
  option: "reorganize" | "preserve",
): Promise<StartedImport> {
  if (file.size > MAX_CSV_BYTES) throw new Error("csv_too_large");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_CSV_BYTES) throw new Error("csv_too_large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  const rows = parseCsv(text);
  const headerRow = rows.shift();
  if (headerRow === undefined) throw new Error("csv_empty");
  if (rows.length > MAX_ROWS) throw new Error("csv_too_many_rows");

  const headers = headerRow.map(header => header.trim().toLowerCase());
  const urlIndex = headers.indexOf("url");
  const titleIndex = headers.indexOf("title");
  const excerptIndex = headers.indexOf("excerpt");
  const tagsIndex = headers.indexOf("tags");
  if (urlIndex === -1) throw new Error("csv_headers");

  const seenUrls = new Set<string>();
  const bookmarks: ImportBookmark[] = [];
  let invalidRows = 0;
  let duplicateRows = 0;
  for (const cells of rows) {
    const sourceUrl = (cells[urlIndex] ?? "").trim();
    if (sourceUrl === "" || sourceUrl.length > 8192) {
      invalidRows += 1;
      continue;
    }
    try {
      const normalized = normalizeBookmarkUrl(sourceUrl);
      if (seenUrls.has(normalized.normalizedUrl)) {
        duplicateRows += 1;
        continue;
      }
      seenUrls.add(normalized.normalizedUrl);
      const importedTitle = titleIndex === -1 ? "" : (cells[titleIndex] ?? "").trim();
      const importedExcerpt = excerptIndex === -1 ? "" : (cells[excerptIndex] ?? "").trim();
      const importedTags = tagsIndex === -1 ? "" : (cells[tagsIndex] ?? "").trim();
      bookmarks.push({
        id: crypto.randomUUID(),
        url: normalized.url,
        normalizedUrl: normalized.normalizedUrl,
        hostname: normalized.hostname,
        title: importedTitle === "" ? normalized.hostname : importedTitle.slice(0, 5000),
        description:
          option === "preserve" && importedExcerpt !== ""
            ? importedExcerpt.slice(0, 5000)
            : null,
        tags: option === "preserve" ? parseTags(importedTags) : [],
        organizationPolicy: option === "preserve" ? "preserve" : "full",
      });
    } catch {
      invalidRows += 1;
    }
  }

  const importId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + IMPORT_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO import_sessions (
        id, status, option, file_name, file_size, file_sha256, total_rows,
        valid_rows, invalid_rows, duplicate_rows, committed_rows, failed_rows,
        created_at, expires_at
      ) VALUES (?, 'committing', ?, ?, ?, '', ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .bind(
      importId,
      option,
      file.name.slice(0, 255),
      file.size,
      rows.length,
      bookmarks.length,
      invalidRows,
      duplicateRows,
      createdAt,
      expiresAt,
    )
    .run();

  const status: ImportStatus = {
    id: importId,
    status: "committing",
    option,
    file_name: file.name.slice(0, 255),
    total_rows: rows.length,
    valid_rows: bookmarks.length,
    invalid_rows: invalidRows,
    duplicate_rows: duplicateRows,
    committed_rows: 0,
    failed_rows: 0,
    processed_rows: invalidRows + duplicateRows,
    created_at: createdAt,
    expires_at: expiresAt,
    committed_at: null,
  };
  return {
    status,
    completion: insertBookmarks(env, importId, bookmarks, createdAt),
  };
}

export async function getImportStatus(db: D1Database, importId: string): Promise<object | null> {
  return db
    .prepare(
      `SELECT id, status, option, file_name, total_rows, valid_rows, invalid_rows,
              duplicate_rows, committed_rows, failed_rows,
              committed_rows + duplicate_rows + invalid_rows + failed_rows AS processed_rows,
              created_at, expires_at, committed_at
         FROM import_sessions
        WHERE id = ?`,
    )
    .bind(importId)
    .first();
}
