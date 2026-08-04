import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBookmark } from "../../src/v6/adapters/library-repository";
import { organizeBookmarkJob } from "../../src/v6/application/organize-bookmark";
import {
  hasPrimaryPageContent,
  type PageContext,
} from "../../src/v6/application/page-content";
import { repairThumbnailBacklog } from "../../src/v6/application/thumbnail-jobs";
import {
  backgroundMessageSchema,
  thumbnailMessageSchema,
} from "../../src/v6/domain/schemas";

function environmentWithAi(response: unknown): Env {
  return {
    DB: env.DB,
    AI: {
      run: () => Promise.resolve(response),
    },
  } as unknown as Env;
}

const substantivePageContext: PageContext = {
  pageTitle: "Retrieved source",
  siteName: "Example",
  metaDescription: null,
  excerpt: "The retrieved page body provides substantive source material for organization.",
  xPost: null,
};

function organize(
  organizationEnv: Env,
  jobId: string,
  pageContext: PageContext | null = substantivePageContext,
) {
  return organizeBookmarkJob(organizationEnv, jobId, {
    resolvePageContext: () => Promise.resolve(pageContext),
  });
}

describe("sequential v6 organization", () => {
  it("keeps the Worker gate objective and sends retrieved login shells to AI", () => {
    expect(hasPrimaryPageContent({
      pageTitle: "Introduction to transformer attention",
      siteName: "Example",
      metaDescription: "Introduction to transformer attention",
      excerpt: null,
      xPost: null,
    }, "Introduction to transformer attention")).toBe(false);
    expect(hasPrimaryPageContent({
      pageTitle: null,
      siteName: "X",
      metaDescription: null,
      excerpt: null,
      xPost: { author: "Example", text: "pic.twitter.com/abc123", externalUrls: [] },
    })).toBe(false);
    expect(hasPrimaryPageContent({
      pageTitle: "Instagram",
      siteName: "Instagram",
      metaDescription: "Create an account or log in to Instagram to see photos and videos.",
      excerpt: "Log in or sign up to continue. Forgot your password? Create an account.",
      xPost: null,
    }, "Instagram")).toBe(true);
    expect(hasPrimaryPageContent(substantivePageContext)).toBe(true);
  });

  it("shares one retry across the Worker gate and an AI insufficient-evidence decision", async () => {
    let aiCalls = 0;
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/title-only",
        title: "A persuasive but unsupported title",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const aiEnv = {
      DB: env.DB,
      AI: {
        run: () => {
          aiCalls += 1;
          return Promise.resolve({
            response: {
              status: "insufficient_evidence",
              tags: [],
              description: "",
              folder: "Websites & Apps",
              confidence: "low",
              notes: "Only a generic login prompt was retrieved.",
            },
          });
        },
      },
    } as unknown as Env;
    const titleOnly: PageContext = {
      pageTitle: "A persuasive but unsupported title",
      siteName: "Example",
      metaDescription: null,
      excerpt: null,
      xPost: null,
    };

    expect(await organize(aiEnv, created.jobId ?? "", titleOnly)).toBe("retry");
    expect(aiCalls).toBe(0);
    expect(
      await env.DB
        .prepare("SELECT state, last_safe_error_code FROM background_jobs WHERE id = ?")
        .bind(created.jobId)
        .first(),
    ).toEqual({ state: "queued", last_safe_error_code: "content_unavailable" });

    const genericLoginShell: PageContext = {
      pageTitle: "Instagram",
      siteName: "Instagram",
      metaDescription: "Create an account or log in to Instagram to see photos and videos.",
      excerpt: null,
      xPost: null,
    };
    expect(await organize(aiEnv, created.jobId ?? "", genericLoginShell)).toBe("review");
    expect(aiCalls).toBe(1);
    expect(
      await env.DB
        .prepare(
          `SELECT b.ai_state, b.description, f.name AS folder_name
             FROM bookmarks b JOIN folders f ON f.id = b.folder_id
            WHERE b.id = ?`,
        )
        .bind(created.bookmark.id)
        .first(),
    ).toEqual({ ai_state: "review", description: null, folder_name: "Need for Review" });
  });

  it("lets AI abstain once and organize successfully after content improves", async () => {
    let aiCalls = 0;
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/eventually-readable",
        title: "Eventually readable",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const aiEnv = {
      DB: env.DB,
      AI: {
        run: () => {
          aiCalls += 1;
          return Promise.resolve({
            response: aiCalls === 1
              ? {
                  status: "insufficient_evidence",
                  tags: [],
                  description: "",
                  folder: "Websites & Apps",
                  confidence: "low",
                  notes: "The retrieved fragment is ambiguous.",
                }
              : {
                  status: "organized",
                  tags: ["distributed-systems"],
                  description: "A detailed guide to reliable distributed systems.",
                  folder: "Articles",
                  confidence: "high",
                  notes: "",
                },
          });
        },
      },
    } as unknown as Env;

    expect(await organize(aiEnv, created.jobId ?? "")).toBe("retry");
    expect(await organize(aiEnv, created.jobId ?? "")).toBe("completed");
    expect(aiCalls).toBe(2);
    expect(
      await env.DB.prepare("SELECT ai_state, description FROM bookmarks WHERE id = ?")
        .bind(created.bookmark.id)
        .first(),
    ).toEqual({
      ai_state: "complete",
      description: "A detailed guide to reliable distributed systems.",
    });
  });

  it("continues organizing Unsorted bookmarks after another bookmark enters review", async () => {
    const first = await createBookmark(
      env.DB,
      {
        url: `https://review-first.example/${crypto.randomUUID()}`,
        title: "Unavailable source",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const second = await createBookmark(
      env.DB,
      {
        url: `https://review-second.example/${crypto.randomUUID()}`,
        title: "Readable source",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const aiEnv = environmentWithAi({
      response: {
        status: "organized",
        tags: ["distributed-systems"],
        description: "A detailed source about reliable distributed systems.",
        folder: "Articles",
        confidence: "high",
        notes: "",
      },
    });

    expect(await organize(aiEnv, first.jobId ?? "", null)).toBe("retry");
    expect(await organize(aiEnv, first.jobId ?? "", null)).toBe("review");
    expect(await organize(aiEnv, second.jobId ?? "", substantivePageContext)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT ai_state FROM bookmarks WHERE id = ?")
        .bind(second.bookmark.id)
        .first(),
    ).toEqual({ ai_state: "complete" });
  });

  it("keeps AI/background and thumbnail queue messages distinct", () => {
    const jobId = crypto.randomUUID();
    const thumbnailMessage = { version: 1, type: "thumbnail", jobId };
    const thumbnailDispatcher = {
      version: 1,
      type: "dispatch_thumbnail_pending",
    };

    expect(thumbnailMessageSchema.safeParse(thumbnailMessage).success).toBe(true);
    expect(thumbnailMessageSchema.safeParse(thumbnailDispatcher).success).toBe(true);
    expect(backgroundMessageSchema.safeParse(thumbnailMessage).success).toBe(false);
    expect(backgroundMessageSchema.safeParse(thumbnailDispatcher).success).toBe(false);
  });

  it("always schedules AI for Unsorted and thumbnails independently", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/unsorted-invariant",
        folderId: "folder_unsorted",
        organizationPolicy: "none",
      },
      "dashboard",
    );
    expect(created.jobId).not.toBeNull();
    expect(created.thumbnailJobId).toBe(created.bookmark.id);
    expect(created.bookmark).toMatchObject({
      folder_id: "folder_unsorted",
      organization_policy: "full",
      ai_state: "pending",
    });

    await env.DB.prepare("DELETE FROM thumbnail_jobs WHERE bookmark_id = ?")
      .bind(created.bookmark.id)
      .run();
    expect(await repairThumbnailBacklog(env)).toBe(true);
    const thumbnailJob = await env.DB
      .prepare("SELECT state FROM thumbnail_jobs WHERE bookmark_id = ?")
      .bind(created.bookmark.id)
      .first();
    expect(thumbnailJob).toEqual({ state: "pending_dispatch" });
  });

  it("applies a valid result under the captured bookmark revision", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/organize",
        title: "Useful systems article",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    expect(created.jobId).not.toBeNull();

    const outcome = await organize(
      environmentWithAi({
        response: {
          status: "organized",
          tags: ["distributed systems"],
          description: "An article about building reliable distributed systems.",
          folder: "Articles",
          confidence: "high",
          notes: "",
        },
      }),
      created.jobId ?? "",
    );
    expect(outcome).toBe("completed");

    const bookmark = await env.DB
      .prepare(
        `SELECT b.ai_state, b.revision, b.description, f.name AS folder_name
           FROM bookmarks b
           JOIN folders f ON f.id = b.folder_id
          WHERE b.id = ?`,
      )
      .bind(created.bookmark.id)
      .first<{
        ai_state: string;
        revision: number;
        description: string;
        folder_name: string;
      }>();
    expect(bookmark).toMatchObject({
      ai_state: "complete",
      revision: 2,
      folder_name: "Articles",
      description: "An article about building reliable distributed systems.",
    });
    const aiTag = await env.DB
      .prepare("SELECT created_by FROM tags WHERE normalized_name = ?")
      .bind("distributed-systems")
      .first<{ created_by: string }>();
    expect(aiTag).toEqual({ created_by: "ai" });
  });

  it("uses preservation mode only to assign a permanent folder", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/preserved-import",
        description: "Imported description",
        tags: ["existing-topic"],
        folderId: "folder_unsorted",
        organizationPolicy: "preserve",
      },
      "raindrop_csv",
    );
    expect(
      await organize(
        environmentWithAi({
          response: {
            status: "organized",
            tags: ["replacement-topic"],
            description: "Replacement description",
            folder: "Articles",
            confidence: "high",
            notes: "",
          },
        }),
        created.jobId ?? "",
      ),
    ).toBe("completed");

    const bookmark = await env.DB
      .prepare("SELECT folder_id, description FROM bookmarks WHERE id = ?")
      .bind(created.bookmark.id)
      .first();
    expect(bookmark).toEqual({
      folder_id: "folder_articles",
      description: "Imported description",
    });
    const tags = await env.DB
      .prepare(
        `SELECT t.normalized_name
           FROM bookmark_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.bookmark_id = ?
          ORDER BY t.normalized_name`,
      )
      .bind(created.bookmark.id)
      .all();
    expect(tags.results).toEqual([{ normalized_name: "existing-topic" }]);
  });

  it("tells the model that setup topics do not limit new subject tags", async () => {
    let prompt = "";
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/history-of-religion",
        title: "A history of religious movements",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const aiEnv = {
      DB: env.DB,
      AI: {
        run: (_model: string, input: { messages: { content: string }[] }) => {
          prompt = input.messages[0]?.content ?? "";
          return Promise.resolve({
            response: {
              status: "organized",
              tags: ["history", "religion"],
              description: "A historical account of religious movements.",
              folder: "Articles",
              confidence: "high",
              notes: "",
            },
          });
        },
      },
    } as unknown as Env;

    expect(await organize(aiEnv, created.jobId ?? "")).toBe("completed");
    expect(prompt).toContain("not a closed taxonomy");
    expect(prompt).toContain("Do not force bookmarks into the user's setup interests");
    expect(prompt).toContain("Do not create synonymous or abbreviated duplicates");
    expect(prompt).toContain("Use the title only as supporting context");
    expect(prompt).toContain("Do not infer a topic from the owner's career");
    expect(prompt).toContain("Return status insufficient_evidence");
    const tags = await env.DB
      .prepare(
        "SELECT normalized_name, created_by FROM tags WHERE normalized_name IN ('history', 'religion') ORDER BY normalized_name",
      )
      .all();
    expect(tags.results).toEqual([
      { normalized_name: "history", created_by: "ai" },
      { normalized_name: "religion", created_by: "ai" },
    ]);
  });

  it("canonicalizes AI abbreviations instead of creating synonymous tags", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/canonical-ai-tag",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    expect(
      await organize(
        environmentWithAi({
          response: {
            status: "organized",
            tags: ["AI", "artificial intelligence"],
            description: "A practical article about artificial intelligence.",
            folder: "Articles",
            confidence: "high",
            notes: "",
          },
        }),
        created.jobId ?? "",
      ),
    ).toBe("completed");
    const linked = await env.DB
      .prepare(
        `SELECT t.normalized_name
           FROM bookmark_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.bookmark_id = ?`,
      )
      .bind(created.bookmark.id)
      .all();
    expect(linked.results).toEqual([{ normalized_name: "artificial-intelligence" }]);
  });

  it("refreshes and retries a job when the bookmark revision is stale", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://example.com/stale",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    await env.DB
      .prepare("UPDATE bookmarks SET revision = revision + 1 WHERE id = ?")
      .bind(created.bookmark.id)
      .run();

    const outcome = await organize(
      environmentWithAi({
        response: {
          status: "organized",
          tags: ["systems"],
          description: "This must not be applied.",
          folder: "Articles",
          confidence: "high",
          notes: "",
        },
      }),
      created.jobId ?? "",
    );
    expect(outcome).toBe("retry");

    const job = await env.DB
      .prepare("SELECT state, last_safe_error_code FROM background_jobs WHERE id = ?")
      .bind(created.jobId)
      .first<{ state: string; last_safe_error_code: string }>();
    expect(job).toMatchObject({ state: "queued", last_safe_error_code: "stale_job_recovered" });
    expect(
      await organize(
        environmentWithAi({
          response: {
            status: "organized",
            tags: ["systems"],
            description: "This applies to the current revision.",
            folder: "Articles",
            confidence: "high",
            notes: "",
          },
        }),
        created.jobId ?? "",
      ),
    ).toBe("completed");
  });

  it("always routes X and Twitter hosts to Social Posts", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://x.com/example/status/123",
        title: "An X post",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    expect(
      await organize(
        environmentWithAi({
          response: {
            status: "organized",
            tags: ["machine-learning"],
            description: "A social post about machine learning.",
            folder: "Websites & Apps",
            confidence: "high",
            notes: "",
          },
        }),
        created.jobId ?? "",
      ),
    ).toBe("completed");
    const folder = await env.DB
      .prepare(
        `SELECT f.name
           FROM bookmarks b
           JOIN folders f ON f.id = b.folder_id
          WHERE b.id = ?`,
      )
      .bind(created.bookmark.id)
      .first<{ name: string }>();
    expect(folder).toEqual({ name: "Social Posts" });
  });

  it("never records a token or neuron usage ledger", async () => {
    const table = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage_events'",
      )
      .first<{ name: string }>();
    expect(table).toBeNull();
  });
});
