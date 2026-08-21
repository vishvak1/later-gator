export type ControlEventCode =
  | "identity_login_started"
  | "identity_login_succeeded"
  | "identity_logout_succeeded"
  | "installer_authorization_started"
  | "installer_authorization_succeeded"
  | "installer_authorization_revoked"
  | "installer_provisioning_advanced"
  | "installer_cleanup_completed"
  | "extension_pairing_started"
  | "extension_pairing_issued"
  | "runtime_login_started"
  | "runtime_login_issued"
  | "owner_metadata_deleted"
  | "request_failed";

/** Emits only an approved event code, opaque request ID, and safe outcome code. */
export function logControlEvent(
  eventCode: ControlEventCode,
  requestId: string,
  outcomeCode: string,
): void {
  console.info(JSON.stringify({ service: "later-gator-control-plane", eventCode, requestId, outcomeCode }));
}
