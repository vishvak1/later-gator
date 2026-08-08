import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBookmark } from "../../src/v6/adapters/library-repository";
import { normalizeWorkersAiResult, OrganizationProviderError, runOrganizationProvider } from "../../src/v6/adapters/organization-providers";
import { resetApplication } from "../../src/v6/application/reset";
import { organizeBookmarkJob } from "../../src/v6/application/organize-bookmark";
import {
  hasPrimaryPageContent,
  hasPrimarySourceDescription,
  isYouTubePlaylistUrl,
  listingEntries,
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
  creator: null,
  entries: null,
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
      creator: null,
      entries: null,
    }, "Introduction to transformer attention")).toBe(false);
    expect(hasPrimaryPageContent({
      pageTitle: null,
      siteName: "X",
      metaDescription: null,
      excerpt: null,
      xPost: { author: "Example", text: "pic.twitter.com/abc123", externalUrls: [] },
      creator: null,
      entries: null,
    })).toBe(false);
    expect(hasPrimaryPageContent({
      pageTitle: "Instagram",
      siteName: "Instagram",
      metaDescription: "Create an account or log in to Instagram to see photos and videos.",
      excerpt: "Log in or sign up to continue. Forgot your password? Create an account.",
      xPost: null,
      creator: null,
      entries: null,
    }, "Instagram")).toBe(true);
    expect(hasPrimaryPageContent(substantivePageContext)).toBe(true);
  });

  it("harvests listing titles only from playlist pages, never from a watch page", () => {
    expect(
      isYouTubePlaylistUrl("https://www.youtube.com/playlist?list=PL4bm2lr9UVG0Hve"),
    ).toBe(true);
    expect(isYouTubePlaylistUrl("https://m.youtube.com/playlist?list=PL4bm")).toBe(true);
    // A watch page renders the same structure for sidebar recommendations.
    expect(isYouTubePlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
    expect(isYouTubePlaylistUrl("https://www.youtube.com/playlist")).toBe(false);
    expect(isYouTubePlaylistUrl("https://example.com/playlist?list=PL4bm")).toBe(false);
  });

  it("reads listing titles from the rendered payload and drops durations", () => {
    const payload =
      '<script>{"metadata":{"lockupMetadataViewModel":{"title":{"content":' +
      '"How LLMs survive in low precision | Quantization Fundamentals"}}},' +
      '"metadata":{"lockupMetadataViewModel":{"title":{"content":' +
      '"The myth of 1-bit LLMs | Quantization-Aware Training"}}},' +
      '"accessibilityContext":{"label":"20 minutes, 34 seconds"}}</script>';
    expect(listingEntries(payload)).toEqual([
      "How LLMs survive in low precision | Quantization Fundamentals",
      "The myth of 1-bit LLMs | Quantization-Aware Training",
    ]);
  });

  it("returns nothing rather than throwing when the payload shape changes", () => {
    expect(listingEntries("<script>{\"someNewShape\":{\"title\":\"x\"}}</script>")).toEqual([]);
    expect(listingEntries("")).toEqual([]);
  });

  it("treats what a listing collects as primary content", () => {
    expect(
      hasPrimaryPageContent({
        pageTitle: "Model Quantization - YouTube",
        siteName: "YouTube",
        // The creator left the description blank, so YouTube substitutes boilerplate.
        metaDescription: "Share your videos with friends, family and the world",
        excerpt: null,
        xPost: null,
        creator: "Julia Turc",
        entries: ["Reverse-engineering GGUF | Post-Training Quantization"],
      }, "Model Quantization"),
    ).toBe(true);
  });

  it("accepts a capture-supplied description as evidence but not a repeated title", () => {
    expect(
      hasPrimarySourceDescription(
        "Rick Astley's official video, remastered in 4K by the original label.",
        "Never Gonna Give You Up",
      ),
    ).toBe(true);
    expect(
      hasPrimarySourceDescription("Never Gonna Give You Up", "Never Gonna Give You Up"),
    ).toBe(false);
    expect(hasPrimarySourceDescription("https://t.co/abc123", "A title")).toBe(false);
    expect(hasPrimarySourceDescription(null, "A title")).toBe(false);
  });

  it("organizes a page whose only evidence is the description the extension read", async () => {
    const created = await createBookmark(
      env.DB,
      {
        url: "https://www.youtube.com/playlist?list=PLevidence",
        title: "Select Lectures - YouTube",
        description:
          "Some lectures on deep learning, deep reinforcement learning, autonomous " +
          "vehicles, and artificial intelligence.",
        organizationPolicy: "full",
      },
      "extension",
    );
    const aiEnv = environmentWithAi({
      response: {
        status: "organized",
        tags: ["machine-learning", "deep-learning", "lectures"],
        description:
          "A YouTube playlist collecting MIT lectures on deep learning, deep " +
          "reinforcement learning, and autonomous vehicles.",
        folder: "Videos & Talks",
        confidence: "high",
        notes: "",
      },
    });

    // No page context at all: the Worker could not retrieve the document.
    expect(await organize(aiEnv, created.jobId ?? "", null)).toBe("completed");
    expect(
      await env.DB
        .prepare(
          `SELECT b.ai_state, f.name AS folder_name
             FROM bookmarks b JOIN folders f ON f.id = b.folder_id
            WHERE b.id = ?`,
        )
        .bind(created.bookmark.id)
        .first(),
    ).toEqual({ ai_state: "complete", folder_name: "Videos & Talks" });
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
      creator: null,
      entries: null,
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
      creator: null,
      entries: null,
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

  it("rescues an unreadable page with one browser render, then organizes it", async () => {
    let renders = 0;
    const created = await createBookmark(
      env.DB,
      {
        url: `https://spa.example/${crypto.randomUUID()}`,
        title: "Client rendered app",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const aiEnv = environmentWithAi({
      response: {
        status: "organized",
        tags: ["distributed-systems", "architecture", "reliability"],
        description: "A detailed walkthrough of building reliable distributed systems.",
        folder: "Articles",
        confidence: "high",
        notes: "",
      },
    });

    expect(
      await organizeBookmarkJob(aiEnv, created.jobId ?? "", {
        // The plain fetch cannot read this page at all.
        resolvePageContext: () => Promise.resolve(null),
        renderPage: () => {
          renders += 1;
          return Promise.resolve({
            title: "Client rendered app",
            text: "A detailed walkthrough of building reliable distributed systems, covering "
              + "consensus, replication, and failure detection in production deployments.",
          });
        },
      }),
    ).toBe("completed");
    expect(renders).toBe(1);
    expect(
      await env.DB
        .prepare("SELECT browser_rendered_at IS NOT NULL AS rendered FROM background_jobs WHERE id = ?")
        .bind(created.jobId)
        .first(),
    ).toEqual({ rendered: 1 });
  });

  it("renders at most once per job, then falls back to the existing retry gate", async () => {
    let renders = 0;
    const created = await createBookmark(
      env.DB,
      {
        url: `https://unreadable.example/${crypto.randomUUID()}`,
        title: "Unreadable",
        organizationPolicy: "full",
      },
      "dashboard",
    );
    const aiEnv = environmentWithAi({ response: { status: "organized" } });
    const dependencies = {
      resolvePageContext: () => Promise.resolve(null),
      renderPage: () => {
        renders += 1;
        return Promise.resolve(null);
      },
    };

    // Render fails, so the shared gate grants its usual single retry.
    expect(await organizeBookmarkJob(aiEnv, created.jobId ?? "", dependencies)).toBe("retry");
    // Second pass must not render again, and exhausts the gate.
    expect(await organizeBookmarkJob(aiEnv, created.jobId ?? "", dependencies)).toBe("review");
    expect(renders).toBe(1);
    expect(
      await env.DB
        .prepare(
          `SELECT b.ai_state, f.name AS folder_name
             FROM bookmarks b JOIN folders f ON f.id = b.folder_id
            WHERE b.id = ?`,
        )
        .bind(created.bookmark.id)
        .first(),
    ).toEqual({ ai_state: "review", folder_name: "Need for Review" });
  });

  it("sends an abstention after a render straight to review, skipping the spare retry", async () => {
    let aiCalls = 0;
    const created = await createBookmark(
      env.DB,
      {
        url: `https://abstain.example/${crypto.randomUUID()}`,
        title: "Ambiguous fragment",
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
              notes: "Still ambiguous after rendering.",
            },
          });
        },
      },
    } as unknown as Env;

    expect(
      await organizeBookmarkJob(aiEnv, created.jobId ?? "", {
        resolvePageContext: () => Promise.resolve(substantivePageContext),
        renderPage: () =>
          Promise.resolve({
            title: "Ambiguous fragment",
            text: "Some additional rendered prose that is still not about any clear subject.",
          }),
      }),
    ).toBe("review");
    // Once before the render, once after: a second abstention is final.
    expect(aiCalls).toBe(2);
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
    // Tags follow three ordered blocks: what it is about, what kind of thing it
    // is, and why the owner would reach for it.
    expect(prompt).toContain("Block A, Content");
    expect(prompt).toContain("Block B, Type");
    expect(prompt).toContain("Block C, Relevance");
    expect(prompt).toContain("Do not force a bookmark into the owner's setup interests");
    expect(prompt).toContain("rather than inventing a synonym");
    // Folder choices carry their tie-breakers, not just a one-line gloss.
    expect(prompt).toContain("The unit is the single post or thread, never a whole account");
    expect(prompt).toContain("A blog summarizing a paper is an Article");
    expect(prompt).toContain("Use the title only as supporting context");
    expect(prompt).toContain("Do not infer a topic from the owner's personal instructions");
    // Career and aspiration were removed; one personalization field replaces them.
    expect(prompt).not.toContain("The owner's current work");
    expect(prompt).not.toContain("working toward");
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

describe("Workers AI response envelopes", () => {
  it("reads both the legacy and the chat-completions shapes", () => {
    // Older models answer with { response }.
    expect(normalizeWorkersAiResult({ response: { ok: "later-gator" } }))
      .toEqual({ response: { ok: "later-gator" } });
    // Newer ones (gpt-oss, nemotron) answer with OpenAI chat completions, and
    // carry reasoning alongside the content that must be ignored.
    expect(normalizeWorkersAiResult({
      choices: [{
        message: { content: '{"ok":"later-gator"}', reasoning: "thinking out loud" },
        finish_reason: "stop",
      }],
    })).toEqual({ response: '{"ok":"later-gator"}' });
    // Models mid-transition send both; the legacy field stays authoritative.
    expect(normalizeWorkersAiResult({
      response: { ok: "later-gator" },
      choices: [{ message: { content: "ignored" } }],
    })).toEqual({ response: { ok: "later-gator" } });
    // Nothing usable degrades to the raw payload rather than inventing one.
    expect(normalizeWorkersAiResult({ choices: [{ message: { content: "" } }] }))
      .toEqual({ choices: [{ message: { content: "" } }] });
  });
});

describe("reset and the vector index", () => {
  it("forgets the vectors of every bookmark it deletes", async () => {
    const deleted: string[][] = [];
    const created = await createBookmark(
      env.DB,
      { url: `https://vectors.test/${crypto.randomUUID()}`, title: "Embedded", organizationPolicy: "none" },
      "dashboard",
    );
    const resetEnv = {
      DB: env.DB,
      VECTORS: { deleteByIds: (ids: string[]) => { deleted.push(ids); return Promise.resolve(); } },
      BACKGROUND_QUEUE: { send: () => Promise.resolve() },
    } as unknown as Env;

    await resetApplication(resetEnv, "session-hash");
    // Orphaned vectors keep matching queries and, because retrieval is top-K,
    // crowd the live library out of every result.
    expect(deleted.flat()).toContain(created.bookmark.id);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM bookmarks").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("Workers AI allocation errors", () => {
  it("recognises the exhausted daily allowance from its real wording", async () => {
    const failing = (message: string): Env => ({
      AI: { run: () => Promise.reject(new Error(message)) },
    } as unknown as Env);
    const classify = async (message: string): Promise<string> => {
      try {
        await runOrganizationProvider(failing(message), "workers-ai", "m", "p", {});
        return "no error";
      } catch (error) {
        return error instanceof OrganizationProviderError ? error.safeCode : "unknown";
      }
    };
    // Verbatim from Workers AI. The old pattern matched none of it, so the one
    // failure the pipeline is designed to pause on looked like a bad model ID.
    expect(await classify(
      "4006: you have used up your daily free allocation of 10,000 neurons, please "
      + "upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
    )).toBe("workers_ai_allocation_exhausted");
    // The historical wording must keep working.
    expect(await classify("3036: daily limit exceeded")).toBe("workers_ai_allocation_exhausted");
    // A genuine model fault is still temporary, not an allocation problem.
    expect(await classify("no such model: @cf/does/not-exist")).toBe("workers_ai_temporary");
  });
});
