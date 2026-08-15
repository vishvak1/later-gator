/**
 * One place that turns a safe provider error code into words, so the same
 * condition reads identically wherever it surfaces. Settings used to print the
 * raw code while the provider test printed a sentence, and a spent allowance
 * could arrive under two different codes, so one situation had several faces.
 *
 * Shared by the Worker and the browser bundle, like the icon and how-to tables.
 */

/** The single code for "the account cannot run Workers AI right now". */
export const WORKERS_AI_LIMIT_CODE = "workers_ai_limit_reached";

const PROVIDER_STATUS_MESSAGES: Readonly<Record<string, string>> = {
  [WORKERS_AI_LIMIT_CODE]:
    "The Workers AI limit has been reached. Sorting pauses and resumes on its own when the allowance resets at UTC midnight.",
  provider_test_invalid:
    "That model did not return the structured JSON Later Gator needs. Choose a model that supports JSON schema output.",
  provider_output_missing:
    "That model returned an empty response. Choose a model that supports JSON schema output.",
  provider_response_schema:
    "That provider replied in an unexpected format. Check the model name.",
  workers_ai_temporary:
    "Workers AI could not run that model. Check the model ID is exactly as shown on the Cloudflare model page, then try again.",
  missing_provider_credential: "Add an API key for this provider first.",
  provider_http_401: "That API key was rejected.",
  provider_http_403: "That API key is not allowed to use this model.",
  provider_http_404: "That model was not found for this provider.",
  provider_network: "The provider could not be reached.",
};

/** Maps a provider operating state to the user-facing settings explanation. */
export function providerStatusMessage(
  safeCode: string | null | undefined,
  fallback = "The provider test failed.",
): string {
  if (safeCode === null || safeCode === undefined || safeCode === "") return fallback;
  return PROVIDER_STATUS_MESSAGES[safeCode] ?? fallback;
}

/** True while the pause is the Workers AI allowance rather than a misconfiguration. */
export function isWorkersAiLimit(safeCode: string | null | undefined): boolean {
  return safeCode === WORKERS_AI_LIMIT_CODE;
}
