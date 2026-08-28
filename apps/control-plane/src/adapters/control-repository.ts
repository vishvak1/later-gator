export interface ControlSessionRecord {
  ownerId: string;
  csrfHash: string;
  expiresAt: number;
}

/** Creates or updates the opaque owner record for a stable Cloudflare subject hash. */
export async function upsertOwner(
  database: D1Database,
  subjectHash: string,
  nowSeconds: number,
): Promise<string> {
  const ownerId = crypto.randomUUID();
  const row = await database
    .prepare(
      `INSERT INTO owners (id, subject_hash, created_at, last_login_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(subject_hash) DO UPDATE SET last_login_at = excluded.last_login_at
       RETURNING id`,
    )
    .bind(ownerId, subjectHash, nowSeconds, nowSeconds)
    .first<{ id: string }>();
  if (row === null) throw new Error("Owner upsert returned no row");
  return row.id;
}

/** Persists only hashes of the control-plane session and CSRF credentials. */
export async function storeControlSession(
  database: D1Database,
  input: {
    sessionHash: string;
    ownerId: string;
    csrfHash: string;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO control_sessions
       (session_hash, owner_id, csrf_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.sessionHash,
      input.ownerId,
      input.csrfHash,
      input.createdAt,
      input.expiresAt,
      input.createdAt,
    )
    .run();
}

/** Retrieves a live session without exposing its bearer credential. */
export async function findControlSession(
  database: D1Database,
  sessionHash: string,
  nowSeconds: number,
): Promise<ControlSessionRecord | null> {
  const row = await database
    .prepare(
      `SELECT owner_id, csrf_hash, expires_at
       FROM control_sessions
       WHERE session_hash = ? AND revoked_at IS NULL AND expires_at >= ?`,
    )
    .bind(sessionHash, nowSeconds)
    .first<{ owner_id: string; csrf_hash: string; expires_at: number }>();
  if (row === null) return null;
  await database
    .prepare("UPDATE control_sessions SET last_seen_at = ? WHERE session_hash = ?")
    .bind(nowSeconds, sessionHash)
    .run();
  return { ownerId: row.owner_id, csrfHash: row.csrf_hash, expiresAt: row.expires_at };
}

/** Revokes a control-plane session by its stored hash. */
export async function revokeControlSession(
  database: D1Database,
  sessionHash: string,
  nowSeconds: number,
): Promise<void> {
  await database
    .prepare("UPDATE control_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL")
    .bind(nowSeconds, sessionHash)
    .run();
}

/** Records a deliberately content-free security audit event. */
export async function storeAuditEvent(
  database: D1Database,
  ownerId: string,
  eventCode: "identity_login_succeeded" | "identity_logout_succeeded",
  nowSeconds: number,
): Promise<void> {
  await database
    .prepare(
      "INSERT INTO control_audit_events (id, owner_id, event_code, occurred_at) VALUES (?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), ownerId, eventCode, nowSeconds)
    .run();
}

/** Deletes only the selected owner's control-plane identity metadata. */
export async function deleteOwnerMetadata(
  database: D1Database,
  ownerId: string,
): Promise<void> {
  await database.batch([
    database.prepare("DELETE FROM control_audit_events WHERE owner_id = ?").bind(ownerId),
    database.prepare("DELETE FROM owners WHERE id = ?").bind(ownerId),
  ]);
}
