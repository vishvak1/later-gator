export interface StoredExtensionConnectRequest {
  redirectUri: string;
  extensionState: string;
  extensionDeviceId: string;
  extensionDeviceName: string;
  nonce: string;
}

/** Stores one short-lived browser-to-extension continuation without OAuth tokens. */
export async function storeExtensionConnectRequest(
  database: D1Database,
  input: StoredExtensionConnectRequest & {
    requestHash: string;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO extension_connect_requests (
         request_hash, redirect_uri, extension_state, extension_device_id,
         extension_device_name, nonce, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.requestHash,
      input.redirectUri,
      input.extensionState,
      input.extensionDeviceId,
      input.extensionDeviceName,
      input.nonce,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}

/** Atomically consumes one extension request so a browser callback cannot replay it. */
export async function consumeExtensionConnectRequest(
  database: D1Database,
  requestHash: string,
  nowSeconds: number,
): Promise<StoredExtensionConnectRequest | null> {
  const row = await database
    .prepare(
      `UPDATE extension_connect_requests SET consumed_at = ?
        WHERE request_hash = ? AND consumed_at IS NULL AND expires_at >= ?
        RETURNING redirect_uri, extension_state, extension_device_id,
                  extension_device_name, nonce`,
    )
    .bind(nowSeconds, requestHash, nowSeconds)
    .first<{
      redirect_uri: string;
      extension_state: string;
      extension_device_id: string;
      extension_device_name: string;
      nonce: string;
    }>();
  return row === null ? null : {
    redirectUri: row.redirect_uri,
    extensionState: row.extension_state,
    extensionDeviceId: row.extension_device_id,
    extensionDeviceName: row.extension_device_name,
    nonce: row.nonce,
  };
}

/** Resolves only safe deployment metadata for one ready owner installation. */
export async function findPairableInstallation(
  database: D1Database,
  ownerId: string,
): Promise<{ installationId: string; workerOrigin: string } | null> {
  const row = await database
    .prepare(
      `SELECT i.id AS installation_id, m.worker_origin
         FROM installations i
         JOIN installation_runtime_metadata m ON m.installation_id = i.id
        WHERE i.owner_id = ? AND i.status = 'ready' AND m.health_status = 'ready'`,
    )
    .bind(ownerId)
    .first<{ installation_id: string; worker_origin: string }>();
  return row === null ? null : {
    installationId: row.installation_id,
    workerOrigin: row.worker_origin,
  };
}

/** Records safe grant metadata for revocation and replay investigations. */
export async function storeExtensionPairingGrant(
  database: D1Database,
  input: {
    jtiHash: string;
    ownerId: string;
    installationId: string;
    extensionDeviceId: string;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO extension_pairing_grants (
         jti_hash, owner_id, installation_id, extension_device_id, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.jtiHash,
      input.ownerId,
      input.installationId,
      input.extensionDeviceId,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}
