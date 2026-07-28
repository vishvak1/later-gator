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
  });

  it("discards a proposal when the bookmark revision is already stale", async () => {
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
    expect(outcome).toBe("acknowledged");

    const job = await env.DB
      .prepare("SELECT state, last_safe_error_code FROM background_jobs WHERE id = ?")
      .bind(created.jobId)
      .first<{ state: string; last_safe_error_code: string }>();
    expect(job).toMatchObject({ state: "cancelled", last_safe_error_code: "stale_job" });
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

