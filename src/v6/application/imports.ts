import { z } from "zod";
import {
  createBookmark,
  dispatchJob,
} from "../adapters/library-repository";
import { normalizeBookmarkUrl } from "../domain/url";
import { ingestThumbnailCandidate } from "./thumbnails";

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const PREVIEW_HOURS = 24;

const csvRowSchema = z.strictObject({
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

interface PreviewSummary {
  importId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  option: "reorganize" | "preserve";
  expiresAt: string;
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

function sourceDate(value: string): string | null {
  const number = Number(value);
  if (Number.isFinite(number) && number > 20_000 && number < 100_000) {
    return new Date((number - 25_569) * 86_400_000).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseTags(value: string): string[] {
  if (value.trim() === "") return [];
  return [...new Set(value.split(/[,;]/u).map((tag) => tag.trim()).filter(Boolean))].slice(0, 50);
}

function rowObject(headers: string[], cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
}

export async function previewRaindropCsv(
  db: D1Database,
  file: File,
  option: "reorganize" | "preserve",
): Promise<PreviewSummary> {
  if (file.size > MAX_CSV_BYTES) throw new Error("csv_too_large");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_CSV_BYTES) throw new Error("csv_too_large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  const rows = parseCsv(text);
  const headerRow = rows.shift();
  if (headerRow === undefined) throw new Error("csv_empty");
  const headers = headerRow.map((header) => header.trim().toLowerCase());
  const required = ["id", "title", "note", "excerpt", "url", "folder", "tags", "created", "cover", "highlights", "favorite"];
  if (!required.every((header) => headers.includes(header))) throw new Error("csv_headers");
  if (rows.length > MAX_ROWS) throw new Error("csv_too_many_rows");

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
  const statements: D1PreparedStatement[] = [];

  for (const [index, cells] of rows.entries()) {
    const parsed = csvRowSchema.safeParse(rowObject(headers, cells));
    let status: "valid" | "invalid" | "duplicate" = "invalid";
    let safeError: string | null = "invalid_row";
    let normalizedUrl: string | null = null;
    if (parsed.success) {
      try {
        normalizedUrl = normalizeBookmarkUrl(parsed.data.url).normalizedUrl;
        const existing = await db
          .prepare("SELECT 1 FROM bookmarks WHERE normalized_url = ? AND deleted_at IS NULL")
          .bind(normalizedUrl)
          .first();
        status = existing === null ? "valid" : "duplicate";
        safeError = existing === null ? null : "duplicate_url";
      } catch {
        status = "invalid";
        safeError = "invalid_url";
      }
    }
    if (status === "valid") validRows += 1;
    else if (status === "duplicate") duplicateRows += 1;
    else invalidRows += 1;
    const data = parsed.success ? parsed.data : null;
    statements.push(
      db
        .prepare(
          `INSERT INTO import_rows (
            import_id, row_number, source_url, normalized_url, title, description, note,
            tags_json, cover_url, source_created_at, row_status, safe_error_code,
            source_id, favorite, excerpt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          importId,
          index + 2,
          data?.url ?? null,
          normalizedUrl,
          blankToNull(data?.title),
          option === "preserve" ? blankToNull(data?.excerpt) : null,
          blankToNull(data?.note),
          option === "preserve" ? JSON.stringify(parseTags(data?.tags ?? "")) : null,
          blankToNull(data?.cover),
          data === null ? null : sourceDate(data.created),
          status,
          safeError,
          blankToNull(data?.id),
          data?.favorite.toLowerCase() === "true" ? 1 : 0,
          blankToNull(data?.excerpt),
        ),
    );
  }

  await db
    .prepare(
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
    )
    .run();
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
  return {
    importId,
    totalRows: rows.length,
    validRows,
    invalidRows,
    duplicateRows,
    option,
    expiresAt,
  };
}

export async function commitImportChunk(
  env: Env,
  importId: string,
): Promise<{ complete: boolean; committed: number; failed: number; remaining: number }> {
  const session = await env.DB
    .prepare(
      `SELECT status, option, expires_at
         FROM import_sessions
        WHERE id = ?`,
    )
    .bind(importId)
    .first<{ status: string; option: "reorganize" | "preserve"; expires_at: string }>();
  if (session === null) throw new Error("import_not_found");
  if (Date.parse(session.expires_at) <= Date.now()) throw new Error("import_expired");
  if (!["preview", "committing"].includes(session.status)) {
    return { complete: session.status === "committed", committed: 0, failed: 0, remaining: 0 };
  }
  await env.DB
    .prepare("UPDATE import_sessions SET status = 'committing' WHERE id = ? AND status = 'preview'")
    .bind(importId)
    .run();
  const rows = await env.DB
    .prepare(
      `SELECT row_number, source_url, normalized_url, title, description, note, tags_json,
              cover_url, source_created_at, favorite, source_id
         FROM import_rows
        WHERE import_id = ? AND row_status = 'valid'
        ORDER BY row_number
        LIMIT 100`,
    )
    .bind(importId)
    .all<ImportRow>();

  let committed = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      const tags =
        session.option === "preserve" && row.tags_json !== null
          ? z.array(z.string()).max(50).parse(JSON.parse(row.tags_json) as unknown)
          : [];
      const created = await createBookmark(
        env.DB,
        {
          url: row.source_url,
          title: row.title,
          description: session.option === "preserve" ? row.description : null,
          note: row.note,
          favorite: row.favorite === 1,
          tags,
          folderId:
            session.option === "preserve" ? "folder_imports" : "folder_unsorted",
          organizationPolicy: session.option === "preserve" ? "preserve" : "full",
        },
        "raindrop_csv",
        { ...(row.source_created_at === null ? {} : { sourceCreatedAt: row.source_created_at }) },
      );
      if (created.created && row.cover_url !== null && row.cover_url !== "") {
        await ingestThumbnailCandidate(env, created.bookmark.id, row.cover_url, "import_cover");
      }
      if (created.jobId !== null) await dispatchJob(env.DB, env.BACKGROUND_QUEUE, created.jobId);
      await env.DB
        .prepare(
          `UPDATE import_rows
              SET row_status = ?, committed_bookmark_id = ?, safe_error_code = ?
            WHERE import_id = ? AND row_number = ?`,
        )
        .bind(
          created.created ? "committed" : "duplicate",
          created.bookmark.id,
          created.created ? null : "duplicate_url",
          importId,
          row.row_number,
        )
        .run();
      committed += 1;
    } catch {
      await env.DB
        .prepare(
          `UPDATE import_rows
              SET row_status = 'failed', safe_error_code = 'commit_failed'
            WHERE import_id = ? AND row_number = ?`,
        )
        .bind(importId, row.row_number)
        .run();
      failed += 1;
    }
  }

  const remaining = await env.DB
    .prepare(
      "SELECT COUNT(*) AS count FROM import_rows WHERE import_id = ? AND row_status = 'valid'",
    )
    .bind(importId)
    .first<{ count: number }>();
  const remainingCount = remaining?.count ?? 0;
  await env.DB
    .prepare(
      `UPDATE import_sessions
          SET committed_rows = committed_rows + ?,
              failed_rows = failed_rows + ?,
              status = CASE WHEN ? = 0 THEN 'committed' ELSE 'committing' END,
              committed_at = CASE WHEN ? = 0 THEN ? ELSE committed_at END
        WHERE id = ?`,
    )
    .bind(
      committed,
      failed,
      remainingCount,
      remainingCount,
      new Date().toISOString(),
      importId,
    )
    .run();
  return {
    complete: remainingCount === 0,
    committed,
    failed,
    remaining: remainingCount,
  };
}

export async function getImportStatus(db: D1Database, importId: string): Promise<object | null> {
  return db
    .prepare(
      `SELECT id, status, option, file_name, total_rows, valid_rows, invalid_rows,
              duplicate_rows, committed_rows, failed_rows, created_at, expires_at, committed_at
         FROM import_sessions
        WHERE id = ?`,
    )
    .bind(importId)
    .first();
}
