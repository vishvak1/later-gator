export interface ImportSession {
  id: string;
  status: "committing" | "committed" | "cancelled" | "expired";
  option: "reorganize" | "preserve";
  file_name: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  committed_rows: number;
  failed_rows: number;
  processed_rows: number;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
}

export interface AutomationProgress {
  total: number;
  complete: number;
  pending: number;
  processing: number;
  waitingProvider: number;
  pausedOwner: number;
  review: number;
  failed: number;
  lastActivityAt: string | null;
}

export interface ProviderState {
  provider: string;
  model: string;
  operational_status: string;
  last_safe_error_code: string | null;
  ai_gateway_id: string | null;
}
