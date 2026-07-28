import { z } from "zod";
import {
  OrganizationProviderError,
  runOrganizationProvider,
  type ProviderName,
} from "../adapters/organization-providers";
import { findPageThumbnail, ingestThumbnailCandidate } from "./thumbnails";

const organizationResultSchema = z.strictObject({
  tags: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
  description: z.string().trim().min(1).max(1000),
  folder: z.enum([
    "Social Posts",
    "Articles",
    "Videos & Talks",
    "Code",
    "Docs & Reference",
    "Papers",
    "Websites & Apps",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().trim().max(1000),
});

const workersEnvelopeSchema = z.looseObject({ response: z.unknown() });

const organizationJsonSchema = {
  type: "object",
  properties: {
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
    description: { type: "string", minLength: 1, maxLength: 1000 },
    folder: {
      type: "string",
      enum: [
        "Social Posts",
        "Articles",
        "Videos & Talks",
        "Code",
        "Docs & Reference",
        "Papers",
        "Websites & Apps",
      ],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: "string", maxLength: 1000 },
  },
  required: ["tags", "description", "folder", "confidence", "notes"],
  additionalProperties: false,
} as const;

interface JobContext {
  job_id: string;
  job_state: string;
  expected_revision: number;
  organization_generation: number;
  quality_attempt_count: number;
  provider: string;
  model: string;
  bookmark_id: string;
  url: string;
  hostname: string;
  title: string;
  description: string | null;
  note: string | null;
  folder_id: string;
  organization_policy: "full" | "preserve" | "none";
  ai_state: string;
  revision: number;
  deleted_at: string | null;
  owner_ai_paused: number;
  edit_mode_state: string;
  current_generation: number;
  personal_instructions: string | null;
}

interface TagRow {
  normalized_name: string;
  display_name: string;
  status: "active" | "retired";
  usage_count: number;
}

type OrganizationResult = z.infer<typeof organizationResultSchema>;

export type OrganizationOutcome =
  | "completed"
  | "acknowledged"
  | "retry"
  | "waiting_provider"
  | "review";

function normalizeTag(value: string): { normalized: string; display: string } {
  const display = value.trim().replace(/\s+/gu, " ");
  return { normalized: display.toLocaleLowerCase("en-US"), display };
}

function parseOrganizationResult(payload: unknown): OrganizationResult | null {
  const envelope = workersEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return null;
  let result = envelope.data.response;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = organizationResultSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function buildPrompt(context: JobContext, tags: TagRow[], correction: boolean): string {
  const registry = tags
    .filter((tag) => tag.status === "active")
    .slice(0, 200)
    .map((tag) => `${tag.display_name}:${tag.usage_count.toString()}`)
    .join(", ");
  const retired = tags
    .filter((tag) => tag.status === "retired")
    .slice(0, 200)
    .map((tag) => tag.display_name)
    .join(", ");
  return [
    "Organize this bookmark for a private personal library.",
    "Folders classify source type. Tags classify subject matter.",
    "Reuse an active tag when it fits. Never return a retired tag.",
    "Return only the requested JSON object.",
    `Title: ${context.title.slice(0, 1000)}`,
    `URL: ${context.url.slice(0, 8192)}`,
    context.description === null ? "" : `Existing description: ${context.description.slice(0, 5000)}`,
    context.note === null ? "" : `User note: ${context.note.slice(0, 5000)}`,
    `Active tag registry: ${registry}`,
    retired.length === 0 ? "" : `Retired tags that must not be used: ${retired}`,
    context.personal_instructions === null
      ? ""
      : `Personal instructions: ${context.personal_instructions.slice(0, 5000)}`,
    correction
      ? "The previous answer failed validation. Correct it and return exactly one valid JSON object."
      : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function loadContext(db: D1Database, jobId: string): Promise<JobContext | null> {
  return db
    .prepare(
      `SELECT
         j.id AS job_id,
         j.state AS job_state,
         j.expected_revision,
         j.organization_generation,
         j.quality_attempt_count,
         j.provider,
         j.model,
         b.id AS bookmark_id,
         b.url,
         b.hostname,
         b.title,
         b.description,
         b.note,
         b.folder_id,
         b.organization_policy,
         b.ai_state,
         b.revision,
         b.deleted_at,
         s.owner_ai_paused,
         s.edit_mode_state,
         s.organization_generation AS current_generation,
         p.personal_instructions
       FROM background_jobs j
       JOIN bookmarks b ON b.id = j.bookmark_id
       JOIN app_state s ON s.id = 1
       LEFT JOIN profile p ON p.id = 1
      WHERE j.id = ?`,
    )
    .bind(jobId)
    .first<JobContext>();
}

async function markState(
  db: D1Database,
  context: JobContext,
  jobState: string,
  bookmarkState: string,
  safeError: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE background_jobs
            SET state = ?, last_safe_error_code = ?, updated_at = ?
          WHERE id = ? AND state NOT IN ('completed', 'cancelled')`,
      )
      .bind(jobState, safeError, now, context.job_id),
    db
      .prepare("UPDATE bookmarks SET ai_state = ? WHERE id = ? AND revision = ?")
      .bind(bookmarkState, context.bookmark_id, context.revision),
  ]);
}

async function applyResult(
  db: D1Database,
  context: JobContext,
  result: OrganizationResult,
  allTags: TagRow[],
): Promise<boolean> {
  const destination = await db
    .prepare("SELECT id FROM folders WHERE name = ? AND is_ai_destination = 1")
    .bind(result.folder)
    .first<{ id: string }>();
  if (destination === null) throw new Error("missing_fixed_folder");

  const tagRows = new Map(allTags.map((tag) => [tag.normalized_name, tag]));
  const selected = new Map<string, { id: string; display: string; exists: boolean }>();
  for (const value of result.tags) {
    const tag = normalizeTag(value);
    const known = tagRows.get(tag.normalized);
    if (known?.status === "retired") continue;
    selected.set(tag.normalized, {
      id: crypto.randomUUID(),
      display: known?.display_name ?? tag.display,
      exists: known !== undefined,
    });
  }
  if (selected.size === 0) throw new Error("no_valid_tags");

  const now = new Date().toISOString();
  const nextRevision = context.expected_revision + 1;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE bookmarks
            SET folder_id = ?,
                description = CASE
                  WHEN organization_policy = 'full' OR description IS NULL OR description = ''
                    THEN ?
                  ELSE description
                END,
                ai_managed_description = CASE
                  WHEN organization_policy = 'full' OR description IS NULL OR description = ''
                    THEN 1
                  ELSE ai_managed_description
                END,
                ai_state = 'complete',
                modified_at = ?,
                revision = revision + 1
          WHERE id = ?
            AND revision = ?
            AND deleted_at IS NULL
            AND ? = (SELECT organization_generation FROM app_state WHERE id = 1)
            AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0
            AND (SELECT edit_mode_state FROM app_state WHERE id = 1) = 'inactive'`,
      )
      .bind(
        destination.id,
        result.description,
        now,
        context.bookmark_id,
        context.expected_revision,
        context.organization_generation,
      ),
  ];

  for (const [normalized, tag] of selected) {
    if (!tag.exists) {
      statements.push(
        db
          .prepare(
            `INSERT INTO tags (
              id, normalized_name, display_name, status, created_by, usage_count, created_at
            )
            SELECT ?, ?, ?, 'active', 'ai', 0, ?
             WHERE EXISTS (
               SELECT 1 FROM bookmarks
                WHERE id = ? AND revision = ? AND modified_at = ?
             )
            ON CONFLICT(normalized_name) DO NOTHING`,
          )
          .bind(tag.id, normalized, tag.display, now, context.bookmark_id, nextRevision, now),
      );
    }
  }

  statements.push(
    db
      .prepare(
        `DELETE FROM bookmark_tags
          WHERE bookmark_id = ? AND source = 'ai'
            AND EXISTS (
              SELECT 1 FROM bookmarks
               WHERE id = ? AND revision = ? AND modified_at = ?
            )`,
      )
      .bind(context.bookmark_id, context.bookmark_id, nextRevision, now),
  );
  for (const normalized of selected.keys()) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, created_at)
           SELECT ?, t.id, 'ai', ?
             FROM tags t
            WHERE t.normalized_name = ? AND t.status = 'active'
              AND EXISTS (
                SELECT 1 FROM bookmarks
                 WHERE id = ? AND revision = ? AND modified_at = ?
              )`,
        )
        .bind(context.bookmark_id, now, normalized, context.bookmark_id, nextRevision, now),
    );
  }
  statements.push(
    db.prepare(
      `UPDATE tags
          SET usage_count = (
            SELECT COUNT(*) FROM bookmark_tags WHERE bookmark_tags.tag_id = tags.id
          )`,
    ),
    db
      .prepare(
        `UPDATE background_jobs
            SET state = 'completed',
                last_safe_error_code = NULL,
                completed_at = ?,
                updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM bookmarks
               WHERE id = ? AND revision = ? AND modified_at = ?
            )`,
      )
      .bind(now, now, context.job_id, context.bookmark_id, nextRevision, now),
  );

  await db.batch(statements);
  const applied = await db
    .prepare("SELECT revision, ai_state FROM bookmarks WHERE id = ?")
    .bind(context.bookmark_id)
    .first<{ revision: number; ai_state: string }>();
  return applied?.revision === nextRevision && applied.ai_state === "complete";
}

export async function organizeBookmarkJob(
  env: Env,
  jobId: string,
): Promise<OrganizationOutcome> {
  const context = await loadContext(env.DB, jobId);
  if (context === null || ["completed", "review", "cancelled", "failed"].includes(context.job_state)) {
    return "acknowledged";
  }
  if (context.deleted_at !== null || context.organization_policy === "none") {
    await markState(env.DB, context, "cancelled", "complete", "job_no_longer_needed");
    return "acknowledged";
  }
  if (
    context.revision !== context.expected_revision ||
    context.organization_generation !== context.current_generation
  ) {
    await markState(env.DB, context, "cancelled", context.ai_state, "stale_job");
    return "acknowledged";
  }
  if (context.owner_ai_paused === 1) {
    await markState(env.DB, context, "paused_owner", "paused_owner", null);
    return "acknowledged";
  }
  if (context.edit_mode_state !== "inactive") {
    await markState(env.DB, context, "paused_edit", "paused_edit", null);
    return "acknowledged";
  }
  if (!["workers-ai", "openai", "anthropic"].includes(context.provider)) {
    await markState(env.DB, context, "failed", "failed", "unsupported_provider");
    return "acknowledged";
  }

  const transition = await env.DB
    .prepare(
      `UPDATE background_jobs
          SET state = 'running', attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND state IN ('pending_dispatch', 'queued', 'waiting_provider')`,
    )
    .bind(new Date().toISOString(), jobId)
    .run();
  if (transition.meta.changes !== 1) return "acknowledged";
  await env.DB
    .prepare("UPDATE bookmarks SET ai_state = 'processing' WHERE id = ? AND revision = ?")
    .bind(context.bookmark_id, context.expected_revision)
    .run();

  const tags = await env.DB
    .prepare(
      `SELECT normalized_name, display_name, status, usage_count
         FROM tags
        ORDER BY status, usage_count DESC, normalized_name`,
    )
    .all<TagRow>();
  const thumbnailCandidate =
    "IMAGES" in env ? await findPageThumbnail(context.url).catch(() => null) : null;

  let result: OrganizationResult | null = null;
  try {
    for (let attempt = 0; attempt < 2 && result === null; attempt += 1) {
      const payload = await runOrganizationProvider(
        env,
        context.provider as ProviderName,
        context.model,
        buildPrompt(context, tags.results, attempt > 0),
        organizationJsonSchema,
      );
      result = parseOrganizationResult(payload);
    }
  } catch (error) {
    if (error instanceof OrganizationProviderError && error.kind === "allocation") {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE provider_settings
                SET operational_status = 'waiting', last_safe_error_code = ?, updated_at = ?
              WHERE id = 1`,
          )
          .bind(error.safeCode, now),
        env.DB
          .prepare(
            `UPDATE background_jobs
                SET state = 'waiting_provider', last_safe_error_code = ?, updated_at = ?
              WHERE state IN ('pending_dispatch', 'queued')`,
          )
          .bind(error.safeCode, now),
        env.DB
          .prepare(
            `UPDATE bookmarks
                SET ai_state = 'waiting_provider'
              WHERE ai_state = 'pending'`,
          ),
      ]);
      await markState(
        env.DB,
        context,
        "waiting_provider",
        "waiting_provider",
        error.safeCode,
      );
      return "waiting_provider";
    }
    if (error instanceof OrganizationProviderError && error.kind === "systemic") {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE provider_settings
                SET operational_status = 'waiting', last_safe_error_code = ?, updated_at = ?
              WHERE id = 1`,
          )
          .bind(error.safeCode, now),
        env.DB
          .prepare(
            `UPDATE background_jobs
                SET state = 'waiting_provider', last_safe_error_code = ?, updated_at = ?
              WHERE state IN ('pending_dispatch', 'queued')`,
          )
          .bind(error.safeCode, now),
        env.DB
          .prepare(
            `UPDATE bookmarks
                SET ai_state = 'waiting_provider'
              WHERE ai_state = 'pending'`,
          ),
      ]);
      await markState(env.DB, context, "waiting_provider", "waiting_provider", error.safeCode);
      return "waiting_provider";
    }
    await env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = 'queued', last_safe_error_code = 'workers_ai_temporary',
                updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .bind(new Date().toISOString(), context.job_id)
      .run();
    await env.DB
      .prepare("UPDATE bookmarks SET ai_state = 'pending' WHERE id = ? AND revision = ?")
      .bind(context.bookmark_id, context.expected_revision)
      .run();
    return "retry";
  }

  if (result === null) {
    const nextQualityAttempt = context.quality_attempt_count + 1;
    if (nextQualityAttempt >= 3) {
      await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE background_jobs
                SET state = 'review', quality_attempt_count = ?,
                    last_safe_error_code = 'invalid_model_result', completed_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(
            nextQualityAttempt,
            new Date().toISOString(),
            new Date().toISOString(),
            context.job_id,
          ),
        env.DB
          .prepare(
            `UPDATE bookmarks
                SET folder_id = 'folder_need_review', ai_state = 'review',
                    modified_at = ?, revision = revision + 1
              WHERE id = ? AND revision = ?`,
          )
          .bind(new Date().toISOString(), context.bookmark_id, context.expected_revision),
      ]);
      return "review";
    }
    await env.DB
      .prepare(
        `UPDATE background_jobs
            SET state = 'queued', quality_attempt_count = ?,
                last_safe_error_code = 'invalid_model_result', updated_at = ?
          WHERE id = ?`,
      )
      .bind(nextQualityAttempt, new Date().toISOString(), context.job_id)
      .run();
    return "retry";
  }

  try {
    const applied = await applyResult(env.DB, context, result, tags.results);
    if (applied) {
      if (thumbnailCandidate !== null) {
        await ingestThumbnailCandidate(
          env,
          context.bookmark_id,
          thumbnailCandidate,
          "page_metadata",
        );
      }
      return "completed";
    }
    await markState(env.DB, context, "cancelled", "pending", "stale_ai_result");
    return "acknowledged";
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "missing_fixed_folder" || error.message === "no_valid_tags")
    ) {
      await markState(env.DB, context, "failed", "failed", error.message);
      return "acknowledged";
    }
    throw error;
  }
}
