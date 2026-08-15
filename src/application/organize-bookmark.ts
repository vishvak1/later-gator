import { z } from "zod";
import {
  OrganizationProviderError,
  runOrganizationProvider,
  type ProviderName,
} from "../adapters/organization-providers";
import { deterministicFolderForHostname } from "../domain/folders";
import { normalizeTagName } from "../domain/tags";
import { createBookmark, relateBookmarks } from "../adapters/library-repository";
import { upsertBookmarkVector } from "./embeddings";
import {
  hasPrimaryPageContent,
  hasPrimarySourceDescription,
  resolvePageContext,
  type PageContext,
} from "./page-content";
import { dispatchJob, dispatchThumbnailJob } from "./queue-dispatch";
import {
  browserBindingPresent,
  renderPageText,
  type RenderedPage,
} from "../adapters/browser-render";

const organizationResultSchema = z.strictObject({
  status: z.enum(["organized", "insufficient_evidence"]),
  tags: z.array(z.string().trim().min(1).max(64)).max(11),
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
      maxItems: 11,
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
  browser_rendered_at: string | null;
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
  ai_gateway_id: string | null;
  personal_instructions: string | null;
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
  renderPage?: (rawUrl: string) => Promise<RenderedPage | null>;
}

export type OrganizationOutcome =
  | "completed"
  | "acknowledged"
  | "retry"
  /** Nothing is wrong and nothing needs waiting for: run it again shortly. */
  | "retry_soon"
  | "waiting_provider"
  | "review";

/** Parses organization result for bookmark organization. */
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

/** Builds prompt for bookmark organization. */
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
    "- Every detail below is retrieved evidence: the title, the site, the page description, the author or channel, any items the page collects, the existing description, the user note, and the page excerpt.",
    "- Judge sufficiency across all of those fields together. Generic or empty material in one field does not make the others insufficient; a page whose description is a site-wide default can still be organized from its title and the items it lists.",
    "- Navigation menus, footers, cookie banners, and legal links are site furniture, not page content. Ignore them entirely and judge only what remains.",
    "- Return status insufficient_evidence only when nothing across every field supports a factual description and subject tags: a login wall, an access shell, or fragments too ambiguous to name any subject.",
    "- For insufficient_evidence return tags [], description \"\", folder \"Websites & Apps\", confidence \"low\", and put a concise reason in notes. The folder is an ignored transport placeholder.",
    "- For organized, return a non-empty description and tags supported by the retrieved evidence.",
    "",
    "Description rules:",
    "- Use the title only as supporting context, never as the sole basis for classification.",
    "- Base every subject claim and tag on the retrieved evidence. Do not infer a topic from the owner's personal instructions.",
    "- Apply a conditional personal instruction only after the retrieved evidence independently establishes that its condition is true.",
    "- Write 2 to 4 full sentences (roughly 40 to 90 words) describing what this page actually contains and why it is worth returning to.",
    "- Name the concrete subjects, technologies, tools, people, and organizations involved so a search for any of them finds this bookmark.",
    "- Never open with filler such as 'This is a bookmark about' or 'This page contains'. State the substance directly.",
    "- For social posts, summarize the post's actual claim or content and name the author when known, including what any linked article or resource is.",
    "",
    "Tag rules. Return the tags array as three ordered blocks, A then B then C.",
    "- Together the blocks tell a stranger what the bookmark is about, what kind of thing it is, and why either of you would reach for it. Example: machine-learning, model-quantization, playlist, course, learning.",
    "- Block A, Content, 3 to 4 tags: what it is actually about, ordered broad to narrow. Domain first, then the specific topic, as in machine-learning then model-quantization.",
    "- Block B, Type, 1 to 3 tags: what kind of resource it is, such as course, tutorial, reference, cheatsheet, or playlist. This deliberately echoes the folder so a tag-only search still finds it. Add a modifier such as education, news, or inspiration when it helps.",
    "- Block C, Relevance, 1 to 4 tags: why it matters. Choose only from career, current-project, learning, reading-list, work, personal, someday, reference-later. Use someday for material with no immediate use so it stays out of active searches.",
    "- Reuse an existing registry tag whenever one accurately fits rather than inventing a synonym; use artificial-intelligence rather than also creating ai. Create precise new tags freely when the registry lacks the subject.",
    "- Do not force a bookmark into the owner's setup interests. Create tags such as history or religion when the content calls for them.",
    "- Every tag must be lowercase and contain one word or hyphen-separated words only.",
    "- Never return a retired tag.",
    "",
    "Folder rules. Choose exactly one, by what the bookmark is rather than where it is hosted.",
    "- Social Posts: one post or thread on a social platform, such as X, LinkedIn, Reddit, Hacker News, or Instagram. The unit is the single post or thread, never a whole account. A blog post merely linked from a post is an Article; a person's whole profile is Websites & Apps.",
    "- Articles: long-form written prose meant to be read start to finish, such as blog posts, news, essays, newsletters, and written tutorials. Opinion and narrative belong here. A journalist's writeup of research stays here even though the research itself is a Paper.",
    "- Videos & Talks: anything whose primary form is video or recorded audio, such as videos, playlists, conference talks, podcast episodes, and recorded lectures. A course delivered as video belongs here. A video embedded in an article saved for its writing is an Article.",
    "- Docs & Reference: official documentation and material looked up rather than read through, such as API docs, language and library references, cheat sheets, specs, and standards. The test is whether the owner would return to look something up. A repository's hosted docs site belongs here; the repository itself is Code.",
    "- Code: code that would be cloned, run, copied, or studied, such as repositories, gists, sandboxes, snippet collections, and package pages. The unit is a runnable or usable code artifact.",
    "- Papers: formal research and academic literature, such as arXiv entries, journal papers, conference proceedings, whitepapers, technical reports, and theses. Always include the tag research, and add venue or year when useful. A blog summarizing a paper is an Article, not a Paper.",
    "- Websites & Apps: a whole site, tool, or product rather than one page, such as SaaS tools, web apps, portfolios, directories, and ongoing resources. One specific article on a site is an Article; the site as a whole belongs here.",
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
    pageContext?.creator === null || pageContext?.creator === undefined || xPost !== null
      ? ""
      : `Published by: ${pageContext.creator}`,
    pageContext?.entries === null || pageContext?.entries === undefined
      ? ""
      : `Items collected on this page: ${pageContext.entries.join("; ").slice(0, 2000)}`,
    xPost === null ? "" : `X post author: ${xPost.author ?? "unknown"}`,
    xPost === null ? "" : `X post text: ${xPost.text}`,
    xPost === null || xPost.externalUrls.length === 0
      ? ""
      : `Links inside the X post: ${xPost.externalUrls.join(", ")}`,
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
  ];
  return [...rules, ...details.filter((line) => line.length > 0)].join("\n");
}

/** Loads context for bookmark organization. */
async function loadContext(db: D1Database, jobId: string): Promise<JobContext | null> {
  return db
    .prepare(
      `SELECT
         j.id AS job_id,
         j.state AS job_state,
         j.expected_revision,
         j.organization_generation,
         j.browser_rendered_at,
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
         ps.ai_gateway_id,
         p.personal_instructions
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

/** Marks state for bookmark organization. */
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

/**
 * The browser fallback. It sits in front of every insufficient-evidence
 * decision and changes nothing else: one render per organization job, skipped
 * entirely when the binding is absent, an import is running, or Cloudflare has
 * already refused for the day. A null result leaves the caller exactly where it
 * was, so the existing retry gate still decides the outcome.
 */
async function rescueWithBrowser(
  env: Env,
  context: JobContext,
  dependencies: OrganizationDependencies,
): Promise<RenderedPage | null> {
  if (context.browser_rendered_at !== null) return null;
  const render = dependencies.renderPage ?? (browserBindingPresent(env) ? renderPageText.bind(null, env) : null);
  if (render === null) return null;
  const now = new Date().toISOString();
  // Marked before the outcome is known: a render that returns nothing must not
  // be retried on the next pass, or a stubborn page would spend the whole day.
  await env.DB
    .prepare("UPDATE background_jobs SET browser_rendered_at = ? WHERE id = ?")
    .bind(now, context.job_id)
    .run();
  context.browser_rendered_at = now;
  return render(context.url).catch(() => null);
}

/** Folds rendered text into whatever the plain fetch already produced. */
function withRenderedPage(
  pageContext: PageContext | null,
  rendered: RenderedPage,
): PageContext {
  return {
    pageTitle: pageContext?.pageTitle ?? rendered.title,
    siteName: pageContext?.siteName ?? null,
    metaDescription: pageContext?.metaDescription ?? null,
    excerpt: rendered.text,
    xPost: pageContext?.xPost ?? null,
    creator: pageContext?.creator ?? null,
    entries: pageContext?.entries ?? null,
  };
}

/**
 * When the provider is worth trying again without the owner doing anything.
 *
 * A spent Workers AI daily allowance resets at midnight UTC, so that is when
 * the pause should lift on its own. Anything systemic — a wrong model ID, a
 * rejected key — returns null, because retrying it on a timer would only burn
 * the allowance again once it came back.
 */
export function allocationRetryAfter(
  error: OrganizationProviderError,
  now: Date = new Date(),
): string | null {
  if (error.kind !== "allocation") return null;
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
}

const INSUFFICIENT_EVIDENCE_CODES = new Set([
  "content_unavailable",
  "ai_insufficient_evidence",
]);

/** Records insufficient evidence for bookmark organization. */
async function recordInsufficientEvidence(
  db: D1Database,
  context: JobContext,
  safeErrorCode: "content_unavailable" | "ai_insufficient_evidence",
  /** Set once the browser has already had its one attempt at this page. */
  exhausted = false,
): Promise<OrganizationOutcome> {
  const now = new Date().toISOString();
  if (
    exhausted ||
    (context.last_safe_error_code !== null &&
      INSUFFICIENT_EVIDENCE_CODES.has(context.last_safe_error_code))
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

/** Applies result for bookmark organization. */
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
export async function linkXPostDestinations(
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

/** Executes one revision-safe organization job from claim through commit. */
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
    /*
     * The work itself succeeded; only the revision moved while it ran. Waiting
     * out the provider back-off would leave the bookmark unsorted for minutes
     * for no reason, so this asks to be run again promptly instead.
     */
    return "retry_soon";
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
  let pageContext =
    pageContextResolver === null ? null : await pageContextResolver(context.url);
  // A description the AI did not write came from the capture surface, which
  // read the page in a real browser. The prompt already passes it through as
  // "Existing description", so it counts as evidence under every policy.
  const sourceDescription =
    context.ai_managed_description === 0 ? context.description : null;
  /** Returns whether current page context contains enough primary evidence. */
  const hasEvidence = (): boolean =>
    hasPrimaryPageContent(pageContext, context.title) ||
    hasPrimarySourceDescription(sourceDescription, context.title);
  if (!hasEvidence()) {
    const rendered = await rescueWithBrowser(env, context, dependencies);
    if (rendered !== null) pageContext = withRenderedPage(pageContext, rendered);
  }
  if (!hasEvidence()) {
    return recordInsufficientEvidence(env.DB, context, "content_unavailable");
  }

  const tags = await env.DB
    .prepare(
      `SELECT normalized_name, display_name, status, usage_count
         FROM tags
        ORDER BY status, usage_count DESC, normalized_name`,
    )
    .all<TagRow>();

  /** Runs one provider evaluation against the current resolved evidence. */
  const evaluate = async (): Promise<OrganizationResult | null> => {
    let evaluated: OrganizationResult | null = null;
    for (let attempt = 0; attempt < 2 && evaluated === null; attempt += 1) {
      const payload = await runOrganizationProvider(
        env,
        context.provider as ProviderName,
        context.model,
        buildPrompt(context, tags.results, pageContext, attempt > 0),
        organizationJsonSchema,
        context.ai_gateway_id,
      );
      evaluated = parseOrganizationResult(payload);
    }
    return evaluated;
  };

  let result: OrganizationResult | null;
  try {
    result = await evaluate();
    // The model saw the cheap page and abstained. Render it once and let the
    // model look again; a second abstention is final.
    if (result?.status === "insufficient_evidence") {
      const rendered = await rescueWithBrowser(env, context, dependencies);
      if (rendered !== null) {
        pageContext = withRenderedPage(pageContext, rendered);
        if (hasEvidence()) result = await evaluate();
      }
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
                SET operational_status = 'waiting', last_safe_error_code = ?,
                    retry_after = ?, updated_at = ?
              WHERE id = 1`,
          )
          .bind(error.safeCode, allocationRetryAfter(error), now),
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
    // A model that abstains after the browser has already rendered the page has
    // seen everything this deployment can retrieve.
    return recordInsufficientEvidence(
      env.DB,
      context,
      "ai_insufficient_evidence",
      context.browser_rendered_at !== null,
    );
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
