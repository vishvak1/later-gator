import { z } from "zod";
import { CredentialDecryptionError } from "../adapters/encrypted-credential-store";
import {
  RaindropHttpError,
  RaindropResponseError,
} from "../adapters/raindrop-client";

export type RaindropConnectionDiagnosticCode =
  | "credential_rejected"
  | "rate_limited"
  | "service_unavailable"
  | "request_rejected"
  | "invalid_response"
  | "secure_storage"
  | "unreachable";

export interface RaindropConnectionDiagnostic {
  code: RaindropConnectionDiagnosticCode;
  summary: string;
  message: string;
}

export function diagnoseRaindropConnection(
  error: unknown,
): RaindropConnectionDiagnostic {
  if (error instanceof CredentialDecryptionError) {
    return {
      code: "secure_storage",
      summary: "Saved token cannot be opened",
      message:
        "Later Gator could not open the securely saved Raindrop token. Save the token again, then retry validation.",
    };
  }

  if (error instanceof RaindropHttpError) {
    if (error.status === 401 || error.status === 403) {
      return {
        code: "credential_rejected",
        summary: "Token rejected",
        message: `Raindrop rejected the saved token (HTTP ${error.status.toString()}). Confirm it is a Raindrop test token for this account, then save it again.`,
      };
    }
    if (error.status === 429) {
      return {
        code: "rate_limited",
        summary: "Temporarily rate limited",
        message:
          "Raindrop is temporarily limiting requests (HTTP 429). Wait a few minutes, then retry validation.",
      };
    }
    if (error.status >= 500) {
      return {
        code: "service_unavailable",
        summary: "Raindrop temporarily unavailable",
        message: `Raindrop is temporarily unavailable (HTTP ${error.status.toString()}). Retry validation later.`,
      };
    }
    return {
      code: "request_rejected",
      summary: "Request rejected",
      message: `Raindrop rejected Later Gator's connection request (HTTP ${error.status.toString()}). The saved token was not displayed or changed.`,
    };
  }

  if (error instanceof RaindropResponseError || error instanceof z.ZodError) {
    return {
      code: "invalid_response",
      summary: "Unexpected Raindrop reply",
      message:
        "Raindrop replied, but Later Gator could not understand the response. Your token and bookmarks were not changed.",
    };
  }

  return {
    code: "unreachable",
    summary: "Could not reach Raindrop",
    message:
      "Later Gator could not reach Raindrop. Check again shortly; your saved token and bookmarks were not changed.",
  };
}
