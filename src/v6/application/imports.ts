import { z } from "zod";
import { normalizeTagNames } from "../domain/tags";
import { normalizeBookmarkUrl } from "../domain/url";
import { ingestThumbnailCandidate } from "./thumbnails";

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const PREVIEW_HOURS = 24;
const MAX_JSON_BINDING_BYTES = 1_500_000;

const csvRowSchema = z.object({
  id: z.string().max(200).default(""),
  title: z.string().max(5000).default(""),
  note: z.string().max(20_000).default(""),
  excerpt: z.string().max(20_000).default(""),
  url: z.string().max(8192),
  folder: z.string().max(1000).default(""),
  tags: z.string().max(10_000).default(""),
  created: z.string().max(100).default(""),
  cover: z.string().max(8192).default(""),
  highlights: z.string().max(20_000).default(""),
  favorite: z.string().max(20).default("false"),
});

interface DuplicatePreview {
  rowNumber: number;
  importedTitle: string | null;
  importedUrl: string;
  existingBookmarkId: string;
  existingTitle: string;
  existingUrl: string;
}

interface PreviewSummary {
  importId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  duplicates: DuplicatePreview[];
  option: "reorganize" | "preserve";
  expiresAt: string;
}

interface ImportSession {
  status: "preview" | "committing" | "committed" | "cancelled" | "expired";
  option: "reorganize" | "preserve";
  expires_at: string;
  created_at: string;
}

interface ImportRow {
  row_number: number;
  source_url: string;
  normalized_url: string;
  title: string | null;
  description: string | null;
  note: string | null;
  tags_json: string | null;
  cover_url: string | null;
  source_created_at: string | null;
  favorite: number;
  source_id: string | null;
  row_status: "valid" | "duplicate";
  safe_error_code: string | null;
}

interface StagedImportRow {
  rowNumber: number;
  sourceUrl: string | null;
  normalizedUrl: string | null;
  title: string | null;
  description: string | null;
  tagsJson: string | null;
  rowStatus: "valid" | "invalid" | "duplicate";
  safeErrorCode: string | null;
  sourceId: string | null;
}

interface BulkBookmark {
  rowNumber: number;
  id: string;
  jobId: string;
  url: string;
  normalizedUrl: string;
  hostname: string;
  title: string;
  description: string | null;
  tags: string[];
  organizationPolicy: "full" | "preserve";
}

function blankToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
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

function parseTags(value: string): string[] {
  if (value.trim() === "") return [];
  return normalizeTagNames(value.split(/[,;]/u), 50);
}

function rowObject(headers: string[], cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
}

function jsonChunks(values: unknown[]): string[] {
  const chunks: string[] = [];
  let current: unknown[] = [];
  let currentBytes = 2;
  const encoder = new TextEncoder();
  for (const value of values) {
    const valueBytes = encoder.encode(JSON.stringify(value)).byteLength;
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (
      current.length > 0 &&
      currentBytes + separatorBytes + valueBytes > MAX_JSON_BINDING_BYTES
    ) {
      chunks.push(JSON.stringify(current));
      current = [];
      currentBytes = 2;
    }
    current.push(value);
    currentBytes += (current.length === 1 ? 0 : 1) + valueBytes;
  }
  if (current.length > 0) chunks.push(JSON.stringify(current));
  return chunks;
}

async function releaseAiAfterImport(env: Env, importId: string): Promise<void> {
  const now = new Date().toISOString();
  const importJobPrefix = `import:${importId}:row:%`;
  await env.DB.batch([
    env.DB
      .prepare(
                `UPDATE background_jobs
            SET state = CASE
                  WHEN (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 1
                    THEN 'paused_owner'
                  WHEN (SELECT operational_status FROM provider_settings WHERE id = 1) = 'waiting'
                    THEN 'waiting_provider'
                  ELSE 'pending_dispatch'
                END,
                updated_at = ?
          WHERE idempotency_key LIKE ?
            AND state NOT IN ('completed', 'cancelled', 'failed', 'review')`,
      )
      .bind(now, importJobPrefix),
    env.DB
      .prepare(
        `UPDATE bookmarks
            SET ai_state = CASE
                  WHEN (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 1
                    THEN 'paused_owner'
                  WHEN (SELECT operational_status FROM provider_settings WHERE id = 1) = 'waiting'
                    THEN 'waiting_provider'
                  ELSE 'pending'
                END
          WHERE EXISTS (
            SELECT 1
              FROM background_jobs j
             WHERE j.bookmark_id = bookmarks.id
               AND j.idempotency_key LIKE ?
          )
            AND ai_state NOT IN ('complete', 'review', 'failed')`,
      )
      .bind(importJobPrefix),
  ]);
  const canDispatch = await env.DB
    .prepare(
      `SELECT 1
         FROM app_state s
         JOIN provider_settings p ON p.id = 1
        WHERE s.id = 1
          AND s.owner_ai_paused = 0
          AND p.operational_status != 'waiting'`,
    )
    .first();
  if (canDispatch !== null) {
    await env.BACKGROUND_QUEUE.send({ version: 1, type: "dispatch_pending" });
  }
}

export async function previewRaindropCsv(
  db: D1Database,
  file: File,
  option: "reorganize" | "preserve",
): Promise<PreviewSummary> {
  const activeImport = await db
    .prepare(
      `SELECT id
         FROM import_sessions
        WHERE status IN ('preview', 'committing') AND expires_at > ?
        LIMIT 1`,
    )
    .bind(new Date().toISOString())
    .first<{ id: string }>();
  if (activeImport !== null) throw new Error("import_already_active");
  if (file.size > MAX_CSV_BYTES) throw new Error("csv_too_large");

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_CSV_BYTES) throw new Error("csv_too_large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  const rows = parseCsv(text);
  const headerRow = rows.shift();
  if (headerRow === undefined) throw new Error("csv_empty");
  const headers = headerRow.map((header) => header.trim().toLowerCase());
  const required = [
    "id",
    "title",
    "note",
    "excerpt",
    "url",
    "tags",
    "created",
    "cover",
    "highlights",
    "favorite",
  ];
  if (!required.every((header) => headers.includes(header))) throw new Error("csv_headers");
  if (rows.length > MAX_ROWS) throw new Error("csv_too_many_rows");

  const seenImportUrls = new Set<string>();
  const importId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREVIEW_HOURS * 60 * 60 * 1000).toISOString();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  let validRows = 0;
  let invalidRows = 0;
  let duplicateRows = 0;
  const duplicates: DuplicatePreview[] = [];
  const stagedRows: StagedImportRow[] = [];

  for (const [index, cells] of rows.entries()) {
    const rowNumber = index + 2;
    const parsed = csvRowSchema.safeParse(rowObject(headers, cells));
    let status: "valid" | "invalid" | "duplicate" = "invalid";
    let safeError: string | null = "invalid_row";
    let normalizedUrl: string | null = null;
    if (parsed.success) {
      try {
        normalizedUrl = normalizeBookmarkUrl(parsed.data.url).normalizedUrl;
        if (seenImportUrls.has(normalizedUrl)) {
          status = "duplicate";
          safeError = "duplicate_in_file";
          duplicateRows += 1;
        } else {
          status = "valid";
          safeError = null;
          seenImportUrls.add(normalizedUrl);
        }
      } catch {
        status = "invalid";
        safeError = "invalid_url";
      }
    }
    if (status === "valid") validRows += 1;
    else if (status === "invalid") invalidRows += 1;
    const data = parsed.success ? parsed.data : null;
    stagedRows.push({
      rowNumber,
      sourceUrl: data?.url ?? null,
      normalizedUrl,
      title: blankToNull(data?.title),
      description: option === "preserve" ? blankToNull(data?.excerpt) : null,
      tagsJson:
        option === "preserve" ? JSON.stringify(parseTags(data?.tags ?? "")) : null,
      rowStatus: status,
      safeErrorCode: safeError,
      sourceId: blankToNull(data?.id),
    });
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO import_sessions (
        id, status, option, file_name, file_size, file_sha256, total_rows,
        valid_rows, invalid_rows, duplicate_rows, created_at, expires_at
      ) VALUES (?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      importId,
      option,
      file.name.slice(0, 255),
      file.size,
      hash,
      rows.length,
      validRows,
      invalidRows,
      duplicateRows,
      now.toISOString(),
      expiresAt,
    ),
  ];
  for (const chunk of jsonChunks(stagedRows)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO import_rows (
            import_id, row_number, source_url, normalized_url, title, description, note,
            tags_json, cover_url, source_created_at, row_status, safe_error_code,
            source_id, favorite, excerpt, existing_bookmark_id
          )
          SELECT ?,
                 CAST(json_extract(value, '$.rowNumber') AS INTEGER),
                 json_extract(value, '$.sourceUrl'),
                 json_extract(value, '$.normalizedUrl'),
                 json_extract(value, '$.title'),
                 json_extract(value, '$.description'),
                 NULL,
                 json_extract(value, '$.tagsJson'),
                 NULL,
                 NULL,
                 json_extract(value, '$.rowStatus'),
                 json_extract(value, '$.safeErrorCode'),
                 json_extract(value, '$.sourceId'),
                 0,
                 NULL,
                 NULL
            FROM json_each(?)`,
        )
        .bind(importId, chunk),
    );
  }
  await db.batch(statements);
  return {
    importId,
    totalRows: rows.length,
    validRows,
    invalidRows,
    duplicateRows,
    duplicates,
    option,
    expiresAt,
  };
}

async function loadImportSession(db: D1Database, importId: string): Promise<ImportSession> {
  const session = await db
    .prepare(
      `SELECT status, option, expires_at, created_at
         FROM import_sessions
        WHERE id = ?`,
    )
    .bind(importId)
    .first<ImportSession>();
  if (session === null) throw new Error("import_not_found");
  if (Date.parse(session.expires_at) <= Date.now() && session.status === "preview") {
    throw new Error("import_expired");
  }
  return session;
}

export async function startImport(
  env: Env,
  importId: string,
): Promise<object> {
  const session = await loadImportSession(env.DB, importId);
  if (session.status === "committed" || session.status === "cancelled") {
    return (await getImportStatus(env.DB, importId)) ?? {};
  }
  await commitImportRows(env, importId, session);
  return (await getImportStatus(env.DB, importId)) ?? {};
}

async function commitImportRows(
  env: Env,
  importId: string,
  session: ImportSession,
): Promise<void> {
  const rows = await env.DB
    .prepare(
      `SELECT row_number, source_url, normalized_url, title, description, tags_json,
              row_status, safe_error_code
         FROM import_rows
        WHERE import_id = ? AND row_status = 'valid'
        ORDER BY row_number`,
    )
    .bind(importId)
    .all<ImportRow>();
  const importTimestamp = session.created_at;
  const bookmarks: BulkBookmark[] = rows.results.map((row) => {
    const normalized = normalizeBookmarkUrl(row.source_url);
    const importedTitle = row.title?.trim();
    const parsedTags =
      session.option === "preserve" && row.tags_json !== null
        ? z.array(z.string()).max(50).parse(JSON.parse(row.tags_json) as unknown)
        : [];
    return {
      rowNumber: row.row_number,
      id: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      url: normalized.url,
      normalizedUrl: normalized.normalizedUrl,
      hostname: normalized.hostname,
      title:
        importedTitle === undefined || importedTitle === ""
          ? normalized.hostname
          : importedTitle,
      description: session.option === "preserve" ? row.description : null,
      tags: normalizeTagNames(parsedTags, 50),
      organizationPolicy: session.option === "preserve" ? "preserve" : "full",
    };
  });
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `UPDATE import_sessions
            SET status = 'committing'
          WHERE id = ? AND status IN ('preview', 'committing')`,
      )
      .bind(importId),
  ];
  for (const chunk of jsonChunks(bookmarks)) {
    statements.push(
      env.DB
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
                 'paused_owner',
                 ?,
                 ?,
                 ?,
                 1
            FROM json_each(?)`,
        )
        .bind(importTimestamp, importTimestamp, importTimestamp, chunk),
    );
  }

  const tagIds = new Map<string, string>();
  for (const bookmark of bookmarks) {
    for (const tag of bookmark.tags) {
      if (!tagIds.has(tag)) tagIds.set(tag, crypto.randomUUID());
    }
  }
  const tags = [...tagIds].map(([name, id]) => ({ id, name }));
  for (const chunk of jsonChunks(tags)) {
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO tags (
            id, normalized_name, display_name, status, created_by, usage_count, created_at
          )
          SELECT json_extract(value, '$.id'),
                 json_extract(value, '$.name'),
                 json_extract(value, '$.name'),
                 'active',
                 'import',
                 0,
                 ?
            FROM json_each(?)`,
        )
        .bind(importTimestamp, chunk),
    );
  }
  const tagLinks = bookmarks.flatMap((bookmark) =>
    bookmark.tags.map((tag) => ({ bookmarkId: bookmark.id, tag })),
  );
  for (const chunk of jsonChunks(tagLinks)) {
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, created_at)
          SELECT json_extract(j.value, '$.bookmarkId'), t.id, 'import', ?
            FROM json_each(?) j
            JOIN bookmarks b ON b.id = json_extract(j.value, '$.bookmarkId')
            JOIN tags t ON t.normalized_name = json_extract(j.value, '$.tag')
           WHERE t.status = 'active'`,
        )
        .bind(importTimestamp, chunk),
    );
  }
  for (const chunk of jsonChunks(bookmarks)) {
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO background_jobs (
            id, bookmark_id, state, expected_revision, organization_generation,
            provider, model, idempotency_key, created_at, updated_at
          )
          SELECT json_extract(j.value, '$.jobId'),
                 b.id,
                 'paused_owner',
                 1,
                 s.organization_generation,
                 p.provider,
                 p.model,
                 'import:' || ? || ':row:' ||
                   CAST(json_extract(j.value, '$.rowNumber') AS TEXT) || ':revision:1',
                 ?,
                 ?
            FROM json_each(?) j
            JOIN bookmarks b ON b.id = json_extract(j.value, '$.id')
            JOIN app_state s ON s.id = 1
            JOIN provider_settings p ON p.id = 1`,
        )
        .bind(importId, importTimestamp, importTimestamp, chunk),
    );
    statements.push(
      env.DB
        .prepare(
          `WITH payload AS (
             SELECT CAST(json_extract(value, '$.rowNumber') AS INTEGER) AS row_number,
                    json_extract(value, '$.id') AS generated_id,
                    json_extract(value, '$.normalizedUrl') AS normalized_url
               FROM json_each(?)
           ),
           committed AS (
             SELECT payload.row_number, payload.generated_id, b.id AS bookmark_id
               FROM payload
               JOIN bookmarks b
                 ON b.normalized_url = payload.normalized_url
                AND b.deleted_at IS NULL
           )
           UPDATE import_rows
              SET row_status = 'committed',
                  committed_bookmark_id = (
                    SELECT bookmark_id FROM committed
                     WHERE committed.row_number = import_rows.row_number
                  ),
                  safe_error_code = CASE
                    WHEN (
                      SELECT bookmark_id = generated_id FROM committed
                       WHERE committed.row_number = import_rows.row_number
                    ) THEN NULL
                    ELSE 'existing_library_skipped'
                  END,
                  processing_token = NULL,
                  processing_started_at = NULL
            WHERE import_id = ?
              AND row_number IN (SELECT row_number FROM committed)`,
        )
        .bind(chunk, importId),
    );
  }
  if (tagLinks.length > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE tags
            SET usage_count = (
              SELECT COUNT(*) FROM bookmark_tags WHERE bookmark_tags.tag_id = tags.id
            )`,
      ),
    );
  }
  statements.push(
    env.DB
      .prepare(
        `UPDATE import_sessions
            SET committed_rows = (
                  SELECT COUNT(*) FROM import_rows
                   WHERE import_id = ? AND row_status = 'committed'
                ),
                failed_rows = 0,
                status = 'committed',
                committed_at = ?
          WHERE id = ?`,
      )
      .bind(importId, new Date().toISOString(), importId),
  );

  await env.DB.batch(statements);
  await releaseAiAfterImport(env, importId);
}

export async function processImportWork(
  env: Env,
  importId: string,
): Promise<"complete" | "continued"> {
  const session = await loadImportSession(env.DB, importId);
  if (session.status !== "committed" && session.status !== "cancelled") {
    await commitImportRows(env, importId, session);
  } else if (session.status === "committed") {
    await releaseAiAfterImport(env, importId);
  }
  return "complete";
}

export async function processImportThumbnailWork(
  env: Env,
  importId: string,
): Promise<"complete" | "continued"> {
  const row = await env.DB
    .prepare(
      `SELECT row_number, committed_bookmark_id, cover_url
         FROM import_rows
        WHERE import_id = ?
          AND row_status = 'committed'
          AND committed_bookmark_id IS NOT NULL
          AND cover_url IS NOT NULL
          AND cover_url != ''
          AND thumbnail_processed_at IS NULL
        ORDER BY row_number
        LIMIT 1`,
    )
    .bind(importId)
    .first<{
      row_number: number;
      committed_bookmark_id: string;
      cover_url: string;
    }>();
  if (row === null) return "complete";

  await ingestThumbnailCandidate(
    env,
    row.committed_bookmark_id,
    row.cover_url,
    "import_cover",
  ).catch(() => false);
  await env.DB
    .prepare(
      `UPDATE import_rows
          SET thumbnail_processed_at = ?
        WHERE import_id = ? AND row_number = ? AND thumbnail_processed_at IS NULL`,
    )
    .bind(new Date().toISOString(), importId, row.row_number)
    .run();
  await env.BACKGROUND_QUEUE.send({ version: 1, type: "import_thumbnails", importId });
  return "continued";
}

/**
 * Cancelling is the user's escape hatch, so it must succeed for any
 * non-terminal session — including one stuck at 'committing' and one whose
 * preview window has already expired. It deliberately does not call
 * loadImportSession, which throws `import_expired` and previously made a
 * wedged import impossible to clear from the UI.
 *
 * Already-committed rows are never withdrawn; cancelling only stops further
 * work and releases the library and AI holds.
 */
export async function cancelImport(env: Env, importId: string): Promise<void> {
  const cancelled = await env.DB
    .prepare(
      `UPDATE import_sessions
          SET status = 'cancelled'
        WHERE id = ? AND status IN ('preview', 'committing')`,
    )
    .bind(importId)
    .run();
  if (cancelled.meta.changes !== 1) {
    const existing = await env.DB
      .prepare("SELECT status FROM import_sessions WHERE id = ?")
      .bind(importId)
      .first<{ status: string }>();
    if (existing === null) throw new Error("import_not_found");
    // Already terminal: treat as success so a retry can never wedge the UI.
    return;
  }
  await env.DB
    .prepare(
      `UPDATE import_rows
          SET row_status = 'invalid', safe_error_code = 'import_cancelled'
        WHERE import_id = ? AND row_status = 'valid'`,
    )
    .bind(importId)
    .run();
  await releaseAiAfterImport(env, importId);
}

export async function getImportStatus(db: D1Database, importId: string): Promise<object | null> {
  const session = await db
    .prepare(
      `SELECT id, status, option, file_name, total_rows, valid_rows, invalid_rows,
              duplicate_rows, committed_rows, failed_rows,
              committed_rows + failed_rows AS processed_rows,
              created_at, expires_at, committed_at
         FROM import_sessions
        WHERE id = ?`,
    )
    .bind(importId)
    .first();
  if (session === null) return null;
  const duplicates = await db
    .prepare(
      `SELECT r.row_number AS rowNumber,
              r.title AS importedTitle,
              r.source_url AS importedUrl,
              r.existing_bookmark_id AS existingBookmarkId,
              b.title AS existingTitle,
              b.url AS existingUrl
         FROM import_rows r
         JOIN bookmarks b ON b.id = r.existing_bookmark_id
        WHERE r.import_id = ? AND r.row_status = 'duplicate'
        ORDER BY r.row_number`,
    )
    .bind(importId)
    .all<DuplicatePreview>();
  return { ...session, duplicates: duplicates.results };
}
