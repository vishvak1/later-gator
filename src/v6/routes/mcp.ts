import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { getBookmarkDetails, listBookmarks } from "../adapters/library-repository";
import { sha256Base64, randomBytes, toBase64 } from "../security/encoding";

const searchInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  folder: z.string().trim().max(100).optional(),
  site: z.string().trim().max(255).optional(),
  favorite: z.boolean().optional(),
  dateField: z.enum(["added_at", "modified_at", "source_created_at"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export async function rotateMcpCredential(db: D1Database): Promise<string> {
  const secret = toBase64(randomBytes(32)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const hash = await sha256Base64(secret);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO mcp_credentials (id, path_secret_hash, created_at, rotated_at)
       VALUES (1, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         path_secret_hash = excluded.path_secret_hash,
         rotated_at = excluded.created_at`,
    )
    .bind(hash, now)
    .run();
  return secret;
}

export async function handleMcp(
  request: Request,
  env: Env,
  context: ExecutionContext,
  suppliedSecret: string,
): Promise<Response> {
  const credential = await env.DB
    .prepare("SELECT 1 FROM mcp_credentials WHERE id = 1 AND path_secret_hash = ?")
    .bind(await sha256Base64(suppliedSecret))
    .first();
  if (credential === null) return new Response(null, { status: 401 });

  const server = new McpServer({ name: "Later Gator", version: "6.0.0" });
  server.registerTool(
    "get_context",
    {
      title: "Get Later Gator context",
      description: "Return current date, timezone, fixed folders, and active tag vocabulary.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [folders, tags, profile] = await Promise.all([
        env.DB
          .prepare("SELECT id, name, slug, kind FROM folders ORDER BY sort_order")
          .all(),
        env.DB
          .prepare(
            `SELECT display_name, normalized_name, usage_count
               FROM tags WHERE status = 'active'
              ORDER BY usage_count DESC, display_name
              LIMIT 500`,
          )
          .all(),
        env.DB.prepare("SELECT timezone FROM profile WHERE id = 1").first<{ timezone: string }>(),
      ]);
      return toolResult({
        currentDate: new Date().toISOString(),
        timezone: profile?.timezone ?? env.TIMEZONE,
        folders: folders.results,
        tags: tags.results,
      });
    },
  );
  server.registerTool(
    "search_bookmarks",
    {
      title: "Search Later Gator bookmarks",
      description: "Search the private library by text, tag, folder, site, favorite, and dates.",
      inputSchema: searchInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const rows = await listBookmarks(env.DB, {
        ...(input.text === undefined ? {} : { q: input.text }),
        ...(input.tags?.[0] === undefined ? {} : { tag: input.tags[0] }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
        ...(input.site === undefined ? {} : { hostname: input.site }),
        ...(input.favorite === undefined ? {} : { favorite: input.favorite ? "true" : "false" }),
        ...(input.dateField === undefined ? {} : { dateField: input.dateField }),
        ...(input.from === undefined ? {} : { dateFrom: input.from }),
        ...(input.to === undefined ? {} : { dateTo: input.to }),
        sort: "modified_at",
        direction: "desc",
        includeTrash: "false",
        limit: input.limit,
      });
      return toolResult(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          url: row.url,
          description: row.description,
          folder: row.folder_name,
          site: row.hostname,
          favorite: row.favorite === 1,
          addedAt: row.added_at,
          modifiedAt: row.modified_at,
          createdAt: row.source_created_at,
          thumbnailAvailable: row.thumbnail_id !== null,
        })),
      );
    },
  );
  server.registerTool(
    "get_bookmark",
    {
      title: "Get one bookmark",
      description: "Return one bookmark and its active tags and related bookmarks.",
      inputSchema: z.strictObject({ id: z.uuid() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => toolResult((await getBookmarkDetails(env.DB, id)) ?? { status: "not_found" }),
  );
  server.registerTool(
    "get_library_status",
    {
      title: "Get library status",
      description: "Return safe bookmark, processing, import, and provider status counts.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [counts, jobs, provider, imports, state] = await Promise.all([
        env.DB
          .prepare(
            `SELECT
               SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash,
               SUM(CASE WHEN ai_state = 'review' THEN 1 ELSE 0 END) AS review
             FROM bookmarks`,
          )
          .first(),
        env.DB
          .prepare(
            `SELECT state, COUNT(*) AS count
               FROM background_jobs
              GROUP BY state`,
          )
          .all(),
        env.DB
          .prepare(
            `SELECT provider, model, operational_status, last_safe_error_code
               FROM provider_settings WHERE id = 1`,
          )
          .first(),
        env.DB
          .prepare(
            `SELECT id, status, committed_rows, failed_rows
               FROM import_sessions
              ORDER BY created_at DESC
              LIMIT 10`,
          )
          .all(),
        env.DB.prepare("SELECT owner_ai_paused FROM app_state WHERE id = 1").first(),
      ]);
      return toolResult({
        counts,
        jobs: jobs.results,
        provider,
        imports: imports.results,
        automation: state,
      });
    },
  );

  return createMcpHandler(server, { route: new URL(request.url).pathname })(
    request,
    env,
    context,
  );
}
