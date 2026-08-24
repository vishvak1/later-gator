export type ControlErrorCode =
  | "bad_request"
  | "identity_provider_unavailable"
  | "identity_token_invalid"
  | "installer_account_selection_invalid"
  | "installer_account_already_linked"
  | "installer_callback_rejected"
  | "installer_provider_unavailable"
  | "installer_scope_rejected"
  | "extension_redirect_rejected"
  | "extension_request_rejected"
  | "method_not_allowed"
  | "not_found"
  | "signing_unavailable"
  | "session_invalid";

export type ControlFailureStage =
  | "control_environment_invalid"
  | "control_public_origin_invalid"
  | "control_oidc_issuer_invalid"
  | "control_access_team_domain_invalid"
  | "control_access_audience_invalid"
  | "control_session_ttl_invalid"
  | "control_identity_client_id_invalid"
  | "control_identity_client_secret_invalid"
  | "control_installer_key_invalid"
  | "session_origin_invalid"
  | "session_cookie_missing"
  | "session_content_type_invalid"
  | "session_form_csrf_invalid"
  | "session_credential_invalid"
  | "session_cookie_mismatch"
  | "session_record_invalid"
  | "session_csrf_binding_invalid";

export class ControlPlaneError extends Error {
  public constructor(
    public readonly code: ControlErrorCode,
    public readonly status: number,
    public readonly failureStage?: ControlFailureStage,
  ) {
    super(code);
    this.name = "ControlPlaneError";
  }
}

/** Signals that Cloudflare definitively rejected the renewable installer credentials. */
export class InstallerAuthorizationRevokedError extends Error {
  public constructor() {
    super("installer_authorization_revoked");
    this.name = "InstallerAuthorizationRevokedError";
  }
}
