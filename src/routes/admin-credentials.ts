import { z } from "zod";
import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { readBoundedUrlEncodedForm, RequestBodyError } from "./request-body";
import { getInstallationSecret, readSetupSession, requireSetupMutation } from "./setup-auth";
import { ProviderConfigStore } from "../adapters/provider-config-store";
import { parseRuntimeConfig } from "../config";

const MAX_REQUEST_BYTES = 8_192;
const CredentialValueSchema = z.string().trim().min(8).max(4_096);
const ProviderNameSchema = z.enum(["anthropic", "openai"]);

export async function credentialStatus(request: Request, env: Env): Promise<Response> {
  const session = await readSetupSession(request, env);
  if (session === null) return new Response(null, { status: 401 });

  const store = createStore(env);
  return jsonResponse({ status: "ok", credentials: await store.getStatus() });
}

export async function saveRaindropCredential(request: Request, env: Env): Promise<Response> {
  const form = await readCredentialForm(request);
  if (form instanceof Response) return form;

  const authorized = await requireSetupMutation(request, env, form.csrfToken);
  if (authorized instanceof Response) return authorized;

  const parsed = CredentialValueSchema.safeParse(form.credential);
  if (!parsed.success) return textError("Raindrop token must be between 8 and 4096 characters.");

  await createStore(env).set("raindrop", parsed.data);
  return redirectToSetup();
}

export async function saveProviderCredential(request: Request, env: Env): Promise<Response> {
  const form = await readCredentialForm(request);
  if (form instanceof Response) return form;

  const authorized = await requireSetupMutation(request, env, form.csrfToken);
  if (authorized instanceof Response) return authorized;

  const provider = ProviderNameSchema.safeParse(form.provider);
  const credential = CredentialValueSchema.safeParse(form.credential);
  if (!provider.success || !credential.success) {
    return textError("Choose OpenAI or Anthropic and enter a key between 8 and 4096 characters.");
  }

  await createStore(env).set(provider.data, credential.data);
  return redirectToSetup();
}

export async function removeProviderCredential(request: Request, env: Env): Promise<Response> {
  const form = await readCredentialForm(request);
  if (form instanceof Response) return form;

  const authorized = await requireSetupMutation(request, env, form.csrfToken);
  if (authorized instanceof Response) return authorized;

  const provider = ProviderNameSchema.safeParse(form.provider);
  if (!provider.success) return textError("Choose OpenAI or Anthropic.");
  if (form.confirmation !== "REMOVE") return textError("Type REMOVE to confirm.");
  const config = parseRuntimeConfig(env);
  const providerState = await new ProviderConfigStore(env.STATE, {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    promptRevision: 1,
  }).get();
  if (providerState.active.provider === provider.data) {
    return textError("Activate a different provider before removing its key.", 409);
  }

  await createStore(env).remove(provider.data);
  return redirectToSetup();
}

function createStore(env: Env): EncryptedCredentialStore {
  return new EncryptedCredentialStore(env.STATE, getInstallationSecret(env));
}

async function readCredentialForm(
  request: Request,
): Promise<
  | {
      credential: string | null;
      csrfToken: string | null;
      provider: string | null;
      confirmation: string | null;
    }
  | Response
> {
  try {
    const form = await readBoundedUrlEncodedForm(request, MAX_REQUEST_BYTES);
    return {
      credential: form.get("credential"),
      csrfToken: form.get("csrfToken"),
      provider: form.get("provider"),
      confirmation: form.get("confirmation"),
    };
  } catch (error) {
    if (error instanceof RequestBodyError) return textError(error.message, error.status);
    throw error;
  }
}

function redirectToSetup(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/setup", "cache-control": "no-store" },
  });
}

function textError(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonResponse(value: unknown): Response {
  return Response.json(value, {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
