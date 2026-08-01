/**
 * Single source of truth for "is an import currently holding something".
 *
 * Two distinct questions were previously conflated across seven call sites,
 * which is what allowed an abandoned preview to make the entire library
 * permanently read-only:
 *
 * - A `preview` is staged, unconfirmed work. It must never block library
 *   mutations, because the user has not agreed to import anything yet and may
 *   simply have closed the tab. PRD 10.4: "Uploading a file does not
 *   immediately commit bookmarks."
 * - A `committing` session is applying rows and does hold the library
 *   read-only. PRD 10.9: "Keeps library mutations read-only while allowing the
 *   user to browse the application."
 *
 * Both predicates are expiry-aware so a wedged session can never hold anything
 * forever; `import_sessions.expires_at` is the backstop.
 */

/** Sessions that make library mutations read-only. Bind one ISO timestamp. */
export const IMPORT_HOLDS_LIBRARY_SQL = `SELECT 1
     FROM import_sessions
    WHERE status = 'committing'
      AND expires_at > ?
    LIMIT 1`;

/**
 * Sessions that suspend AI organization. Staged previews are included because
 * PRD 10.9 pauses AI "before preview/commit", but expiry still applies so an
 * abandoned preview cannot stop organization indefinitely.
 */
export const IMPORT_HOLDS_AI_SQL = `SELECT 1
     FROM import_sessions
    WHERE status IN ('preview', 'committing')
      AND expires_at > ?
    LIMIT 1`;

export async function importHoldsLibrary(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(IMPORT_HOLDS_LIBRARY_SQL)
    .bind(new Date().toISOString())
    .first();
  return row !== null;
}

export async function importHoldsAi(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(IMPORT_HOLDS_AI_SQL)
    .bind(new Date().toISOString())
    .first();
  return row !== null;
}
