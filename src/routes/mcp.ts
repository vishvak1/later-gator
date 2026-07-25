import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { EncryptedCredentialStore } from "../adapters/encrypted-credential-store";
import { createOrganizationProvider } from "../adapters/organization-provider";
import { ProviderConfigStore } from "../adapters/provider-config-store";
import { RaindropClient } from "../adapters/raindrop-client";
import {
  getContext,
  getPipelineStatus,
  searchBookmarks,
} from "../application/mcp-services";
import { resumePipeline } from "../application/pipeline-control";
import { parseRuntimeConfig } from "../config";
import { FolderNameSchema, type ProviderChoice } from "../domain/schemas";
import {
  getInstallationSecret,
  readSetupSession,
  secretsEqual,
} from "./setup-auth";

const McpSecretEnvironmentSchema = z.object({
  MCP_PATH_SECRET: z.string().length(64),
});
const DateSchema = z.iso.date();
const SearchInputSchema = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    tags: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    folder: FolderNameSchema.optional(),
    from: DateSchema.optional(),
    to: DateSchema.optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .refine(
    (input) =>
      input.text !== undefined ||
      input.tags !== undefined ||
      input.folder !== undefined ||
      input.from !== undefined ||
      input.to !== undefined,
    "At least one search constraint is required",
  )
  .refine(
    (input) => input.from === undefined || input.to === undefined || input.from <= input.to,
    "from must not be after to",
  );

export async function handleMcp(
  request: Request,
  env: Env,
  context: ExecutionContext,
  suppliedSecret: string,
): Promise<Response> {
  const configuredSecret = McpSecretEnvironmentSchema.safeParse(env);
  const credentialStore = new EncryptedCredentialStore(
    env.STATE,
    getInstallationSecret(env),
  );
  let rotatedSecret: string | null;
  try {
    rotatedSecret = await credentialStore.get("mcpPath");
  } catch {
    return new Response(null, { status: 401 });
  }
  const activeSecret = rotatedSecret ?? (
    configuredSecret.success ? configuredSecret.data.MCP_PATH_SECRET : null
  );
  if (
    activeSecret === null ||
    !(await secretsEqual(suppliedSecret, activeSecret))
  ) {
    return new Response(null, { status: 401 });
  }

  const config = parseRuntimeConfig(env);
  const token = await credentialStore.get("raindrop");
  if (token === null) return new Response(null, { status: 503 });
  const raindrop = new RaindropClient(token);
  const providerStore = new ProviderConfigStore(env.STATE, initialChoice(config));
  const provider = await providerStore.get();
  const server = new McpServer({ name: "Later Gator", version: "1.0.0" });

  server.registerTool(
    "get_context",
    {
      title: "Get Later Gator context",
      description:
        "Learn the exact managed folders, tag vocabulary, usage counts, timezone, and current date before searching.",
    },
    async () => toolResult(await getContext(env.STATE, config.TIMEZONE)),
  );
  server.registerTool(
    "search_bookmarks",
    {
      title: "Search bookmarks",
      description:
        "Search the Raindrop library using meaning-oriented text plus optional exact tags, folder, and ISO date constraints.",
      inputSchema: SearchInputSchema,
    },
    async (input) =>
      toolResult(
        await searchBookmarks(env.STATE, raindrop, {
          limit: input.limit,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
        }),
      ),
  );
  server.registerTool(
    "get_pipeline_status",
    {
      title: "Get pipeline status",
      description:
        "Check onboarding, connected-account match, pending work, pause or deferral state, and active organization provider.",
    },
    async () => toolResult(await getPipelineStatus(env.STATE, raindrop, provider)),
  );
  server.registerTool(
    "resume_pipeline",
    {
      title: "Resume organization pipeline",
      description:
        "Resume a user-action-required pause only after revalidating Raindrop identity and the active provider.",
      inputSchema: z.object({
        confirmation: z.boolean(),
        note: z.string().trim().max(500).optional(),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ confirmation }) => {
      const providerCredential =
        provider.active.provider === "workers-ai"
          ? null
          : await credentialStore.get(provider.active.provider);
      try {
        const organizationProvider = createOrganizationProvider(provider.active, {
          ai: env.AI,
          credential: providerCredential,
        });
        return toolResult(
          await resumePipeline(
            env.STATE,
            raindrop,
            organizationProvider,
            confirmation,
          ),
        );
      } catch {
        return toolResult({
          status: "refused",
          reason: "provider_validation_failed",
        });
      }
    },
  );

  return createMcpHandler(server)(request, env, context);
}

export async function adminMcpContext(request: Request, env: Env): Promise<Response> {
  const session = await readSetupSession(request, env);
  if (session === null) return new Response(null, { status: 401 });
  const config = parseRuntimeConfig(env);
  return Response.json(await getContext(env.STATE, config.TIMEZONE), {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function initialChoice(config: ReturnType<typeof parseRuntimeConfig>): ProviderChoice {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    promptRevision: 1,
  };
}
