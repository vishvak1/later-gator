import { z } from "zod";
import {
  OrganizationProviderError,
  runOrganizationProvider,
  type ProviderName,
} from "../adapters/organization-providers";
import { deterministicFolderForHostname } from "../domain/folders";
import { importHoldsAi } from "../domain/import-state";
import { normalizeTagName } from "../domain/tags";
import { createBookmark, dispatchJob, relateBookmarks } from "../adapters/library-repository";
import { upsertBookmarkVector } from "./embeddings";
import {
  hasPrimaryPageContent,
  hasPrimarySourceDescription,
  resolvePageContext,
  type PageContext,
} from "./page-content";
import { dispatchThumbnailJob } from "./thumbnail-jobs";

const organizationResultSchema = z.strictObject({
  status: z.enum(["organized", "insufficient_evidence"]),
  tags: z.array(z.string().trim().min(1).max(64)).max(8),
  description: z.string().trim().max(1000),
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
}).superRefine((result, context) => {
  if (result.status === "organized") {
    if (result.tags.length === 0) {
      context.addIssue({ code: "custom", path: ["tags"], message: "organized result needs tags" });
    }
    if (result.description.length === 0) {
      context.addIssue({ code: "custom", path: ["description"], message: "organized result needs a description" });
    }
    return;
  }
  if (result.tags.length !== 0) {
    context.addIssue({ code: "custom", path: ["tags"], message: "insufficient result cannot contain tags" });
  }
  if (result.description.length !== 0) {
    context.addIssue({ code: "custom", path: ["description"], message: "insufficient result cannot contain a description" });
  }
  if (result.folder !== "Websites & Apps") {
    context.addIssue({ code: "custom", path: ["folder"], message: "insufficient result uses the ignored placeholder folder" });
  }
  if (result.confidence !== "low") {
    context.addIssue({ code: "custom", path: ["confidence"], message: "insufficient result must be low confidence" });
  }
  if (result.notes.length === 0) {
    context.addIssue({ code: "custom", path: ["notes"], message: "insufficient result needs a reason" });
  }
});

const workersEnvelopeSchema = z.looseObject({ response: z.unknown() });

const organizationJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["organized", "insufficient_evidence"] },
    tags: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: { type: "string" },
    },
    description: { type: "string", minLength: 0, maxLength: 1000 },
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
  required: ["status", "tags", "description", "folder", "confidence", "notes"],
  additionalProperties: false,
} as const;

interface JobContext {
  job_id: string;
  job_state: string;
  expected_revision: number;
  organization_generation: number;
  quality_attempt_count: number;
  last_safe_error_code: string | null;
  provider: string;
  model: string;
  bookmark_id: string;
  url: string;
  hostname: string;
  title: string;
  description: string | null;
  ai_managed_description: number;
  note: string | null;
  folder_id: string;
  organization_policy: "full" | "preserve" | "none";
  ai_state: string;
  revision: number;
  deleted_at: string | null;
  owner_ai_paused: number;
  current_generation: number;
  provider_status: string;
  personal_instructions: string | null;
  career_context: string | null;
  aspiration_context: string | null;
}

interface TagRow {
  normalized_name: string;
  display_name: string;
  status: "active" | "retired";
  usage_count: number;
}

type OrganizationResult = z.infer<typeof organizationResultSchema>;

interface OrganizationDependencies {
  resolvePageContext?: (rawUrl: string) => Promise<PageContext | null>;
}

export type OrganizationOutcome =
  | "completed"
  | "acknowledged"
  | "retry"
  | "waiting_provider"
  | "review";

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

function buildPrompt(
  context: JobContext,
  tags: TagRow[],
  pageContext: PageContext | null,
  correction: boolean,
): string {
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
  const xPost = pageContext?.xPost ?? null;
  const rules = [
    "You organize a private personal bookmark library so its owner can retrieve anything months later.",
    "Return only the requested JSON object.",
    "",
    "Evidence sufficiency rules:",
    "- The Worker retrieved at least one primary content field, but that content may still be generic, blocked, ambiguous, or inadequate for reliable organization.",
    "- First decide whether the retrieved source content is sufficient to support a factual description and subject tags.",
    "- Return status insufficient_evidence for login prompts, access shells, generic platform boilerplate, ambiguous fragments, or any material that does not support reliable subject claims.",
    "- For insufficient_evidence return tags [], description \"\", folder \"Websites & Apps\", confidence \"low\", and put a concise reason in notes. The folder is an ignored transport placeholder.",
    "- For organized, return a non-empty description and tags supported by the retrieved source content.",
    "",
    "Description rules:",
    "- Use the title only as supporting context, never as the sole basis for classification.",
    "- Base every subject claim and tag on the retrieved source content. Do not infer a topic from the owner's career, aspirations, or personal instructions.",
    "- Apply a conditional personal instruction only after the source content independently establishes that its condition is true.",
    "- Write 2 to 4 full sentences (roughly 40 to 90 words) describing what this page actually contains and why it is worth returning to.",
    "- Name the concrete subjects, technologies, tools, people, and organizations involved so a search for any of them finds this bookmark.",
    "- Never open with filler such as 'This is a bookmark about' or 'This page contains'. State the substance directly.",
    "- For social posts, summarize the post's actual claim or content and name the author when known, including what any linked article or resource is.",
    "",
    "Tag rules:",
    "- Folders classify source type. Tags classify subject matter.",
    "- Choose 3 to 6 tags mixing one or two broad subjects with precise specifics.",
    "- The active tag registry is a convenience, not a closed taxonomy.",
    "- Reuse an active tag only when it accurately fits. Create precise new subject tags whenever the bookmark introduces a topic that is missing from the registry.",
    "- Treat setup seed tags as examples and preferences, never as a target vocabulary or a limit on how many tags the library may contain.",
    "- Do not create synonymous or abbreviated duplicates. Reuse the registry's canonical wording; for example, use artificial-intelligence rather than also creating ai.",
    "- Do not force bookmarks into the user's setup interests. For example, create tags such as history or religion when the content calls for them.",
    "- Every tag must be lowercase and contain one word or hyphen-separated words only.",
    "- Never return a retired tag.",
    "",
    "Folder rules:",
    "- Social Posts: posts on X, Reddit, LinkedIn, and similar social platforms.",
    "- Articles: news stories, essays, and blog posts.",
    "- Videos & Talks: video pages and recorded talks.",
    "- Code: repositories and code hosting.",
    "- Docs & Reference: official documentation and reference material.",
    "- Papers: research papers and preprints.",
    "- Websites & Apps: tools, products, homepages, and anything without a better fit.",
    "",
  ];
  const details = [
    `Title: ${context.title.slice(0, 1000)}`,
    `URL: ${context.url.slice(0, 8192)}`,
    pageContext?.pageTitle === null || pageContext?.pageTitle === undefined
      ? ""
      : `Page title: ${pageContext.pageTitle}`,
    pageContext?.siteName === null || pageContext?.siteName === undefined
      ? ""
      : `Site: ${pageContext.siteName}`,
    pageContext?.metaDescription === null || pageContext?.metaDescription === undefined
      ? ""
      : `Page meta description: ${pageContext.metaDescription}`,
    pageContext?.excerpt === null || pageContext?.excerpt === undefined
      ? ""
      : `Page content excerpt: ${pageContext.excerpt}`,
    xPost === null ? "" : `X post author: ${xPost.author ?? "unknown"}`,
    xPost === null ? "" : `X post text: ${xPost.text}`,
    xPost === null || xPost.externalUrls.length === 0
      ? ""
      : `Links inside the X post: ${xPost.externalUrls.join(", ")}`,
    context.description === null ? "" : `Existing description: ${context.description.slice(0, 5000)}`,
    context.note === null ? "" : `User note: ${context.note.slice(0, 5000)}`,
    `Active tag registry: ${registry}`,
    retired.length === 0 ? "" : `Retired tags that must not be used: ${retired}`,
    context.career_context === null || context.career_context.length === 0
      ? ""
      : `The owner's current work: ${context.career_context.slice(0, 2000)}`,
    context.aspiration_context === null || context.aspiration_context.length === 0
      ? ""
      : `The owner is working toward: ${context.aspiration_context.slice(0, 2000)}`,
    context.personal_instructions === null
      ? ""
      : `Personal instructions: ${context.personal_instructions.slice(0, 5000)}`,
    correction
      ? "The previous answer failed validation. Correct it and return exactly one valid JSON object."
      : "",
  ];
  return [...rules, ...details.filter((line) => line.length > 0)].join("\n");
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
         j.last_safe_error_code,
         j.provider,
         j.model,
         b.id AS bookmark_id,
         b.url,
         b.hostname,
         b.title,
         b.description,
         b.ai_managed_description,
         b.note,
         b.folder_id,
         b.organization_policy,
         b.ai_state,
         b.revision,
         b.deleted_at,
         s.owner_ai_paused,
         s.organization_generation AS current_generation,
         ps.operational_status AS provider_status,
         p.personal_instructions,
         p.career_context,
         p.aspiration_context
       FROM background_jobs j
       JOIN bookmarks b ON b.id = j.bookmark_id
       JOIN app_state s ON s.id = 1
       JOIN provider_settings ps ON ps.id = 1
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

const INSUFFICIENT_EVIDENCE_CODES = new Set([
  "content_unavailable",
  "ai_insufficient_evidence",
]);

async function recordInsufficientEvidence(
  db: D1Database,
  context: JobContext,
  safeErrorCode: "content_unavailable" | "ai_insufficient_evidence",
): Promise<OrganizationOutcome> {
  const now = new Date().toISOString();
  if (
    context.last_safe_error_code !== null &&
    INSUFFICIENT_EVIDENCE_CODES.has(context.last_safe_error_code)
  ) {
    await db.batch([
      db
        .prepare(
          `UPDATE background_jobs
              SET state = 'review', last_safe_error_code = ?,
                  completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .bind(safeErrorCode, now, now, context.job_id),
      db
        .prepare(
          `UPDATE bookmarks
              SET folder_id = 'folder_need_review', ai_state = 'review',
                  modified_at = ?, revision = revision + 1
            WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        )
        .bind(now, context.bookmark_id, context.expected_revision),
    ]);
    return "review";
  }
  await db.batch([
    db
      .prepare(
        `UPDATE background_jobs
            SET state = 'queued', last_safe_error_code = ?, updated_at = ?
          WHERE id = ? AND state = 'running'`,
      )
      .bind(safeErrorCode, now, context.job_id),
    db
      .prepare(
        `UPDATE bookmarks SET ai_state = 'pending'
          WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      )
      .bind(context.bookmark_id, context.expected_revision),
  ]);
  return "retry";
}

async function applyResult(
  db: D1Database,
  context: JobContext,
  result: OrganizationResult,
  allTags: TagRow[],
): Promise<boolean> {
  const folderName = deterministicFolderForHostname(context.hostname) ?? result.folder;
  const destination = await db
    .prepare("SELECT id FROM folders WHERE name = ? AND is_ai_destination = 1")
    .bind(folderName)
    .first<{ id: string }>();
  if (destination === null) throw new Error("missing_fixed_folder");

  const tagRows = new Map(allTags.map((tag) => [tag.normalized_name, tag]));
  const selected = new Map<string, { id: string; display: string; exists: boolean }>();
  if (context.organization_policy === "full") {
    for (const value of result.tags) {
      const tag = normalizeTagName(value);
      if (tag.normalized === "") continue;
      const known = tagRows.get(tag.normalized);
      if (known?.status === "retired") continue;
      selected.set(tag.normalized, {
        id: crypto.randomUUID(),
        display: known?.display_name ?? tag.display,
        exists: known !== undefined,
      });
    }
  }
  if (context.organization_policy === "full" && selected.size === 0) {
    throw new Error("no_valid_tags");
  }

  const now = new Date().toISOString();
  const nextRevision = context.expected_revision + 1;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE bookmarks
            SET folder_id = ?,
                description = CASE
                  WHEN organization_policy = 'full' THEN ?
                  ELSE description
                END,
                ai_managed_description = CASE
                  WHEN organization_policy = 'full' THEN 1
                  ELSE ai_managed_description
                END,
                ai_state = 'complete',
                modified_at = ?,
                revision = revision + 1
          WHERE id = ?
            AND revision = ?
            AND deleted_at IS NULL
            AND ? = (SELECT organization_generation FROM app_state WHERE id = 1)
            AND (SELECT owner_ai_paused FROM app_state WHERE id = 1) = 0`,
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

  if (context.organization_policy === "full") {
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

/**
 * X handling: an X post and the article or resource it links to become two
 * separate bookmarks connected through a `related` relationship. The linked
 * destination starts in Unsorted and receives its own organization job.
 */
async function linkXPostDestinations(
  env: Env,
  bookmarkId: string,
  urls: string[],
): Promise<void> {
  for (const url of urls) {
    try {
      const linked = await createBookmark(
        env.DB,
        { url, folderId: "folder_unsorted", organizationPolicy: "full" },
        "linked",
      );
      if (linked.bookmark.id === bookmarkId) continue;
      await relateBookmarks(env.DB, bookmarkId, linked.bookmark.id);
      if (linked.jobId !== null && "BACKGROUND_QUEUE" in env) {
        await dispatchJob(env.DB, env.BACKGROUND_QUEUE, linked.jobId);
      }
      if (linked.thumbnailJobId !== null && "THUMBNAIL_QUEUE" in env) {
        await dispatchThumbnailJob(env.DB, env.THUMBNAIL_QUEUE, linked.thumbnailJobId);
      }
    } catch {
      // The X post itself is already organized; a failed link never fails the job.
    }
  }
}

export async function organizeBookmarkJob(
  env: Env,
  jobId: string,
  dependencies: OrganizationDependencies = {},
): Promise<OrganizationOutcome> {
  const context = await loadContext(env.DB, jobId);
  if (context === null || ["completed", "review", "cancelled", "failed"].includes(context.job_state)) {
    return "acknowledged";
  }
  if (context.deleted_at !== null || context.organization_policy === "none") {
    await markState(env.DB, context, "cancelled", "complete", "job_no_longer_needed");
    return "acknowledged";
  }
  if (context.folder_id !== "folder_unsorted") {
    await markState(env.DB, context, "cancelled", "complete", "bookmark_left_unsorted");
    return "acknowledged";
  }
  if (
    context.revision !== context.expected_revision ||
    context.organization_generation !== context.current_generation
  ) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE background_jobs
              SET state = 'queued',
                  expected_revision = ?,
                  organization_generation = ?,
                  last_safe_error_code = 'stale_job_recovered',
                  updated_at = ?
            WHERE id = ? AND state NOT IN ('completed', 'review', 'failed')`,
        )
        .bind(context.revision, context.current_generation, now, context.job_id),
      env.DB
        .prepare("UPDATE bookmarks SET ai_state = 'pending' WHERE id = ? AND deleted_at IS NULL")
        .bind(context.bookmark_id),
    ]);
    return "retry";
  }
  if (await importHoldsAi(env.DB)) {
    const jobState =
      context.owner_ai_paused === 1
        ? "paused_owner"
        : context.provider_status === "waiting"
            ? "waiting_provider"
            : "pending_dispatch";
    const bookmarkState =
      jobState === "paused_owner"
        ? "paused_owner"
        : jobState === "waiting_provider"
            ? "waiting_provider"
            : "pending";
    await markState(env.DB, context, jobState, bookmarkState, null);
    return "acknowledged";
  }
  if (context.owner_ai_paused === 1) {
    await markState(env.DB, context, "paused_owner", "paused_owner", null);
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

  const environment = (env as { ENVIRONMENT?: string }).ENVIRONMENT;
  const pageContextResolver =
    dependencies.resolvePageContext ??
    (environment !== undefined && environment !== "test" ? resolvePageContext : null);
  const pageContext =
    pageContextResolver === null ? null : await pageContextResolver(context.url);
  // A description the AI did not write came from the capture surface, which
  // read the page in a real browser. The prompt already passes it through as
  // "Existing description", so it counts as evidence under every policy.
  const sourceDescription =
    context.ai_managed_description === 0 ? context.description : null;
  const hasPrimaryContent =
    hasPrimaryPageContent(pageContext, context.title) ||
    hasPrimarySourceDescription(sourceDescription, context.title);
  if (!hasPrimaryContent) {
    return recordInsufficientEvidence(env.DB, context, "content_unavailable");
  }

  const tags = await env.DB
    .prepare(
      `SELECT normalized_name, display_name, status, usage_count
         FROM tags
        ORDER BY status, usage_count DESC, normalized_name`,
    )
    .all<TagRow>();

  let result: OrganizationResult | null = null;
  try {
    for (let attempt = 0; attempt < 2 && result === null; attempt += 1) {
      const payload = await runOrganizationProvider(
        env,
        context.provider as ProviderName,
        context.model,
        buildPrompt(context, tags.results, pageContext, attempt > 0),
        organizationJsonSchema,
      );
      result = parseOrganizationResult(payload);
    }
  } catch (error) {
    if (
      error instanceof OrganizationProviderError &&
      (error.kind === "allocation" || error.kind === "systemic")
    ) {
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

  if (result.status === "insufficient_evidence") {
    return recordInsufficientEvidence(env.DB, context, "ai_insufficient_evidence");
  }

  try {
    const applied = await applyResult(env.DB, context, result, tags.results);
    if (applied) {
      if (pageContext?.xPost !== null && pageContext?.xPost !== undefined) {
        await linkXPostDestinations(env, context.bookmark_id, pageContext.xPost.externalUrls);
      }
      await upsertBookmarkVector(env, context.bookmark_id).catch(() => undefined);
      return "completed";
    }
    const current = await loadContext(env.DB, context.job_id);
    if (current === null) return "acknowledged";
    if (current.deleted_at !== null) return "acknowledged";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE background_jobs
              SET state = 'queued',
                  expected_revision = ?,
                  organization_generation = ?,
                  last_safe_error_code = 'stale_ai_result_recovered',
                  updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .bind(current.revision, current.current_generation, now, context.job_id),
      env.DB
        .prepare("UPDATE bookmarks SET ai_state = 'pending' WHERE id = ? AND deleted_at IS NULL")
        .bind(context.bookmark_id),
    ]);
    return "retry";
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
