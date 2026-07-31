import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBookmark } from "../../src/v6/adapters/library-repository";
import { organizeBookmarkJob } from "../../src/v6/application/organize-bookmark";

function environmentWithAi(response: unknown): Env {
  return {
    DB: env.DB,
    AI: {
      run: () => Promise.resolve(response),
    },
  } as unknown as Env;
}

describe("sequential v6 organization", () => {
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

    const outcome = await organizeBookmarkJob(
      environmentWithAi({
        response: {
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

    expect(await organizeBookmarkJob(aiEnv, created.jobId ?? "")).toBe("completed");
    expect(prompt).toContain("not a closed taxonomy");
    expect(prompt).toContain("Do not force bookmarks into the user's setup interests");
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

    const outcome = await organizeBookmarkJob(
      environmentWithAi({
        response: {
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
      await organizeBookmarkJob(
        environmentWithAi({
          response: {
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
      await organizeBookmarkJob(
        environmentWithAi({
          response: {
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
