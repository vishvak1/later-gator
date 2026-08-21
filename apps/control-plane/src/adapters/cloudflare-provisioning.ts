import { systemHealthSchema, type SystemHealth } from "@later-gator/contracts";
import { z } from "zod";
import type { RuntimeReleaseArtifact } from "../application/releases";
import { fetchVerifiedReleaseFile } from "../application/releases";
import { readBoundedJson } from "./bounded-json";

const API_ORIGIN = "https://api.cloudflare.com";
const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const uuidSchema = z.uuid();
const compactUuidSchema = z.string().regex(/^[a-f0-9]{32}$/iu);
const workerVersionIdSchema = z.union([uuidSchema, compactUuidSchema]).transform((value) => {
  if (value.includes("-")) return value.toLowerCase();
  const normalized = value.toLowerCase();
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
});
/** Wraps one validated Cloudflare result in its successful API envelope. */
const apiEnvelopeSchema = <T extends z.ZodType>(result: T) => z.object({
  success: z.literal(true),
  result,
}).loose();

export class CloudflareProvisioningError extends Error {
  public constructor(
    public readonly safeCode: "cloudflare_unavailable" | "cloudflare_rejected" |
      "cloudflare_worker_fetch_blocked" | "r2_subscription_required",
    public readonly status: number,
  ) {
    super(safeCode);
    this.name = "CloudflareProvisioningError";
  }
}

export interface ProvisionedResources {
  d1DatabaseId: string;
  oauthKvNamespaceId: string;
  thumbnailStorageId: string;
  vectorizeIndexName: string;
  backgroundQueueId: string;
  backgroundQueueName: string;
  thumbnailQueueId: string;
  thumbnailQueueName: string;
  workerName: string;
  workerOrigin: string;
}

export interface WorkerUploadResult {
  versionId: string;
}

const deploymentSchema = z.object({
  id: uuidSchema,
  versions: z.array(z.object({
    percentage: z.number().min(0).max(100),
    version_id: uuidSchema,
  }).loose()).min(1).max(100),
}).loose();

/** Recognizes only Cloudflare's bounded same-zone Worker routing error body. */
async function isSameZoneWorkerFetchBlock(response: Response): Promise<boolean> {
  const maximumBytes = 64;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) return false;
  if (response.body === null) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        return false;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return false;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes).trim() === "error code: 1042";
}

/** Encodes binary assets without variadic expansion or logging their contents. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

/** Returns a conservative response media type from the immutable asset path. */
function assetMediaType(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase();
  return ({
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

/** Builds the exact bindings owned by one personal installation. */
function runtimeBindings(
  resources: ProvisionedResources,
  storageMode: "kv" | "r2",
  installationId: string,
  controlPlaneOrigin: string,
  instanceSecret?: string,
): Record<string, unknown>[] {
  const bindings: Record<string, unknown>[] = [
    { name: "LIBRARY_EVENTS", type: "durable_object_namespace", class_name: "LibraryEvents" },
    storageMode === "kv"
      ? { name: "THUMBNAILS", type: "kv_namespace", namespace_id: resources.thumbnailStorageId }
      : { name: "THUMBNAILS_R2", type: "r2_bucket", bucket_name: resources.thumbnailStorageId },
    { name: "OAUTH_KV", type: "kv_namespace", namespace_id: resources.oauthKvNamespaceId },
    { name: "BACKGROUND_QUEUE", type: "queue", queue_name: resources.backgroundQueueName },
    { name: "THUMBNAIL_QUEUE", type: "queue", queue_name: resources.thumbnailQueueName },
    { name: "DB", type: "d1", id: resources.d1DatabaseId },
    { name: "VECTORS", type: "vectorize", index_name: resources.vectorizeIndexName },
    { name: "BROWSER", type: "browser" },
    { name: "IMAGES", type: "images" },
    { name: "AI", type: "ai" },
    { name: "ASSETS", type: "assets" },
    { name: "ENVIRONMENT", type: "plain_text", text: "production" },
    { name: "TIMEZONE", type: "plain_text", text: "UTC" },
    { name: "PUBLIC_ORIGIN", type: "plain_text", text: resources.workerOrigin },
    { name: "CONTROL_PLANE_ORIGIN", type: "plain_text", text: controlPlaneOrigin },
    { name: "INSTALLATION_ID", type: "plain_text", text: installationId },
  ];
  if (instanceSecret !== undefined) {
    bindings.push({ name: "INSTANCE_MASTER_KEY", type: "secret_text", text: instanceSecret });
  }
  return bindings;
}

/** Calls one Cloudflare API endpoint and validates only the required response subset. */
async function cloudflareJson<T>(
  fetcher: typeof fetch,
  token: string,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    if (!(init.body instanceof FormData)) headers.set("content-type", "application/json");
    response = await fetcher(new URL(path, API_ORIGIN), {
      ...init,
      headers,
      redirect: "manual",
    });
  } catch {
    throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
  }
  if (!response.ok) {
    if (path.includes("/r2/") && [400, 402, 403].includes(response.status)) {
      throw new CloudflareProvisioningError("r2_subscription_required", 409);
    }
    throw new CloudflareProvisioningError(
      response.status >= 500 ? "cloudflare_unavailable" : "cloudflare_rejected",
      response.status >= 500 ? 503 : 409,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
  return parsed.data;
}

export class CloudflareProvisioner {
  public constructor(
    private readonly accountId: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Deletes one resource idempotently without retaining Cloudflare response details. */
  private async delete(path: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, API_ORIGIN), {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.accessToken}` },
        redirect: "manual",
      });
    } catch {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    if (response.ok || response.status === 404) return;
    throw new CloudflareProvisioningError(
      response.status >= 500 ? "cloudflare_unavailable" : "cloudflare_rejected",
      response.status >= 500 ? 503 : 409,
    );
  }

  /** Deletes one recorded Later Gator resource by its provider-specific identifier. */
  public async deleteResource(resource: {
    type: "d1" | "oauth_kv" | "thumbnail_kv" | "thumbnail_r2" | "vectorize" |
      "background_queue" | "thumbnail_queue" | "worker";
    id: string;
    name: string;
  }): Promise<void> {
    const encodedId = encodeURIComponent(resource.id);
    const encodedName = encodeURIComponent(resource.name);
    const path = ({
      d1: `/client/v4/accounts/${this.accountId}/d1/database/${encodedId}`,
      oauth_kv: `/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${encodedId}`,
      thumbnail_kv: `/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${encodedId}`,
      thumbnail_r2: `/client/v4/accounts/${this.accountId}/r2/buckets/${encodedName}`,
      vectorize: `/client/v4/accounts/${this.accountId}/vectorize/v2/indexes/${encodedName}`,
      background_queue: `/client/v4/accounts/${this.accountId}/queues/${encodedId}`,
      thumbnail_queue: `/client/v4/accounts/${this.accountId}/queues/${encodedId}`,
      worker: `/client/v4/accounts/${this.accountId}/workers/scripts/${encodedName}`,
    } as const)[resource.type];
    await this.delete(path);
  }

  /** Finds or creates one D1 database under a deterministic installation name. */
  public async ensureD1(name: string): Promise<string> {
    const databaseSchema = z.object({ uuid: uuidSchema, name: z.string() }).loose();
    const listed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=50`,
      apiEnvelopeSchema(z.array(databaseSchema)),
    );
    const existing = listed.result.find((database) => database.name === name);
    if (existing !== undefined) return existing.uuid;
    const created = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/d1/database`,
      apiEnvelopeSchema(databaseSchema),
      { method: "POST", body: JSON.stringify({ name }) },
    );
    return created.result.uuid;
  }

  /** Finds or creates one KV namespace by its deterministic title. */
  public async ensureKv(title: string): Promise<string> {
    const namespaceSchema = z.object({ id: identifierSchema, title: z.string() }).loose();
    const listed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/storage/kv/namespaces?per_page=100`,
      apiEnvelopeSchema(z.array(namespaceSchema)),
    );
    const existing = listed.result.find((namespace) => namespace.title === title);
    if (existing !== undefined) return existing.id;
    const created = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/storage/kv/namespaces`,
      apiEnvelopeSchema(namespaceSchema),
      { method: "POST", body: JSON.stringify({ title }) },
    );
    return created.result.id;
  }

  /** Finds or creates one R2 bucket, classifying inactive billing as an owner pause. */
  public async ensureR2(name: string): Promise<string> {
    const bucketSchema = z.object({ name: z.string().min(3).max(64) }).loose();
    const listed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/r2/buckets?per_page=100`,
      apiEnvelopeSchema(z.union([
        z.array(bucketSchema),
        z.object({ buckets: z.array(bucketSchema) }).loose(),
      ])),
    );
    const buckets = Array.isArray(listed.result) ? listed.result : listed.result.buckets;
    if (buckets.some((bucket) => bucket.name === name)) return name;
    const created = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/r2/buckets`,
      apiEnvelopeSchema(bucketSchema),
      { method: "POST", body: JSON.stringify({ name, storageClass: "Standard" }) },
    );
    return created.result.name;
  }

  /** Finds or creates the fixed 1024-dimension cosine Vectorize index. */
  public async ensureVectorize(name: string): Promise<string> {
    const indexSchema = z.object({
      name: z.string(),
      config: z.object({ dimensions: z.number(), metric: z.string() }).loose().optional(),
    }).loose();
    const listed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/vectorize/v2/indexes`,
      apiEnvelopeSchema(z.array(indexSchema)),
    );
    const existing = listed.result.find((index) => index.name === name);
    if (existing !== undefined) {
      if (
        existing.config !== undefined &&
        (existing.config.dimensions !== 1024 || existing.config.metric !== "cosine")
      ) {
        throw new CloudflareProvisioningError("cloudflare_rejected", 409);
      }
      return existing.name;
    }
    const created = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/vectorize/v2/indexes`,
      apiEnvelopeSchema(indexSchema),
      {
        method: "POST",
        body: JSON.stringify({
          name,
          description: "Later Gator semantic bookmark search",
          config: { dimensions: 1024, metric: "cosine" },
        }),
      },
    );
    return created.result.name;
  }

  /** Finds or creates one Queue and returns its immutable account identifier. */
  public async ensureQueue(queueName: string): Promise<{ id: string; name: string }> {
    const queueSchema = z.object({ queue_id: identifierSchema, queue_name: z.string() }).loose();
    const listed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/queues?per_page=100`,
      apiEnvelopeSchema(z.union([
        z.array(queueSchema),
        z.object({ queues: z.array(queueSchema) }).loose(),
      ])),
    );
    const queues = Array.isArray(listed.result) ? listed.result : listed.result.queues;
    const existing = queues.find((queue) => queue.queue_name === queueName);
    if (existing !== undefined) return { id: existing.queue_id, name: existing.queue_name };
    const created = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/queues`,
      apiEnvelopeSchema(queueSchema),
      { method: "POST", body: JSON.stringify({ queue_name: queueName }) },
    );
    return { id: created.result.queue_id, name: created.result.queue_name };
  }

  /** Resolves the account's existing workers.dev suffix without changing it. */
  public async accountSubdomain(): Promise<string> {
    const response = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/subdomain`,
      apiEnvelopeSchema(z.object({ subdomain: z.string().min(1).max(128) }).loose()),
    );
    return response.result.subdomain;
  }

  /** Registers and uploads only the immutable assets Cloudflare reports missing. */
  private async uploadAssets(
    workerName: string,
    artifact: RuntimeReleaseArtifact,
    artifacts: Fetcher,
  ): Promise<string> {
    const session = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${workerName}/assets-upload-session`,
      apiEnvelopeSchema(z.object({
        jwt: z.string().min(16).max(32_768),
        buckets: z.array(z.array(z.string().regex(/^[a-f0-9]{32}$/u))).max(10_000),
      }).loose()),
      {
        method: "POST",
        body: JSON.stringify({
          manifest: Object.fromEntries(
            artifact.assets.map((asset) => [asset.path, { hash: asset.assetHash, size: asset.size }]),
          ),
        }),
      },
    );
    let completionToken = session.result.jwt;
    const byHash = new Map(artifact.assets.map((asset) => [asset.assetHash, asset]));
    for (const bucket of session.result.buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const asset = byHash.get(hash);
        if (asset === undefined) throw new Error("release_asset_bucket_invalid");
        const bytes = await fetchVerifiedReleaseFile(
          artifacts,
          asset.artifactPath,
          asset.sha256,
          25_000_000,
        );
        form.set(
          hash,
          new Blob([base64(new Uint8Array(bytes))], { type: assetMediaType(asset.path) }),
          asset.path.slice(1) || hash,
        );
      }
      const uploaded = await cloudflareJson(
        this.fetcher,
        session.result.jwt,
        `/client/v4/accounts/${this.accountId}/workers/assets/upload?base64=true`,
        apiEnvelopeSchema(z.object({ jwt: z.string().min(16).max(32_768).optional() }).loose()),
        { method: "POST", body: form },
      );
      if (uploaded.result.jwt !== undefined) completionToken = uploaded.result.jwt;
    }
    return completionToken;
  }

  /** Uploads a fresh personal Worker with exact bindings and a non-exported instance secret. */
  public async uploadInitialWorker(
    artifact: RuntimeReleaseArtifact,
    artifacts: Fetcher,
    resources: ProvisionedResources,
    installationId: string,
    storageMode: "kv" | "r2",
    controlPlaneOrigin: string,
    instanceSecret: string,
  ): Promise<WorkerUploadResult> {
    const assetsJwt = await this.uploadAssets(resources.workerName, artifact, artifacts);
    const moduleBytes = await fetchVerifiedReleaseFile(
      artifacts,
      artifact.mainModule.artifactPath,
      artifact.mainModule.sha256,
      15_000_000,
    );
    const form = new FormData();
    form.set("metadata", JSON.stringify({
      main_module: "runtime.mjs",
      compatibility_date: artifact.compatibilityDate,
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      assets: { jwt: assetsJwt, config: { html_handling: "none", not_found_handling: "none" } },
      bindings: runtimeBindings(
        resources,
        storageMode,
        installationId,
        controlPlaneOrigin,
        instanceSecret,
      ),
      exports: { LibraryEvents: { type: "durable-object", storage: "sqlite" } },
      annotations: { "workers/message": `Later Gator ${artifact.release}`, "workers/tag": artifact.release },
    }));
    form.set("runtime.mjs", new Blob([moduleBytes], { type: "application/javascript+module" }), "runtime.mjs");
    const uploaded = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${resources.workerName}?excludeScript=true&bindings_inherit=strict`,
      apiEnvelopeSchema(z.object({
        deployment_id: workerVersionIdSchema,
      }).loose()),
      { method: "PUT", body: form },
    );
    // Cloudflare's stable multipart upload response retains the legacy field
    // name `deployment_id`, but its value is the newly deployed Worker version.
    return { versionId: uploaded.result.deployment_id };
  }

  /** Uploads an immutable version while inheriting the existing secret binding. */
  public async uploadWorkerVersion(
    artifact: RuntimeReleaseArtifact,
    artifacts: Fetcher,
    resources: ProvisionedResources,
    installationId: string,
    storageMode: "kv" | "r2",
    controlPlaneOrigin: string,
  ): Promise<WorkerUploadResult> {
    const assetsJwt = await this.uploadAssets(resources.workerName, artifact, artifacts);
    const moduleBytes = await fetchVerifiedReleaseFile(
      artifacts,
      artifact.mainModule.artifactPath,
      artifact.mainModule.sha256,
      15_000_000,
    );
    const form = new FormData();
    form.set("metadata", JSON.stringify({
      main_module: "runtime.mjs",
      compatibility_date: artifact.compatibilityDate,
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      assets: { jwt: assetsJwt, config: { html_handling: "none", not_found_handling: "none" } },
      bindings: runtimeBindings(resources, storageMode, installationId, controlPlaneOrigin),
      exports: { LibraryEvents: { type: "durable-object", storage: "sqlite" } },
      annotations: { "workers/message": `Later Gator ${artifact.release}`, "workers/tag": artifact.release },
    }));
    form.set("runtime.mjs", new Blob([moduleBytes], { type: "application/javascript+module" }), "runtime.mjs");
    const uploaded = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${resources.workerName}/versions?bindings_inherit=strict`,
      apiEnvelopeSchema(z.object({ id: uuidSchema }).loose()),
      { method: "POST", body: form },
    );
    return { versionId: uploaded.result.id };
  }

  /** Applies idempotent schema statements as a bounded D1 query batch. */
  public async applySchema(databaseId: string, statements: string[]): Promise<void> {
    await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/d1/database/${databaseId}/query`,
      apiEnvelopeSchema(z.array(z.object({ success: z.boolean().optional() }).loose())),
      {
        method: "POST",
        body: JSON.stringify({
          batch: statements.map((sql) => ({ sql })),
        }),
      },
    );
  }

  /** Records D1's current Time Travel position before a release migration. */
  public async timeTravelBookmark(databaseId: string): Promise<string> {
    const response = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/d1/database/${databaseId}/time_travel/bookmark`,
      apiEnvelopeSchema(z.object({ bookmark: z.string().min(8).max(512) }).loose()),
    );
    return response.result.bookmark;
  }

  /** Creates a Queue consumer if it is not already attached to this Worker. */
  public async ensureQueueConsumer(
    queueId: string,
    workerName: string,
    maxConcurrency: number,
  ): Promise<void> {
    const consumerSchema = z.object({
      consumer_id: identifierSchema.optional(),
      script_name: z.string().optional(),
      type: z.string().optional(),
    }).loose();
    const listed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/queues/${queueId}/consumers`,
      apiEnvelopeSchema(z.array(consumerSchema)),
    );
    if (listed.result.some((consumer) => consumer.script_name === workerName)) return;
    await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/queues/${queueId}/consumers`,
      apiEnvelopeSchema(consumerSchema),
      {
        method: "POST",
        body: JSON.stringify({
          script_name: workerName,
          type: "worker",
          settings: {
            batch_size: 1,
            max_wait_time_ms: 1000,
            max_retries: 5,
            max_concurrency: maxConcurrency,
          },
        }),
      },
    );
  }

  /** Enables only the personal Worker's workers.dev route. */
  public async enableWorkersDev(workerName: string): Promise<void> {
    await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${workerName}/subdomain`,
      apiEnvelopeSchema(z.object({ enabled: z.boolean() }).loose()),
      { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }) },
    );
  }

  /** Returns the sole version receiving all traffic in the latest active deployment. */
  public async activeVersion(workerName: string): Promise<string> {
    const response = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
      apiEnvelopeSchema(z.object({
        deployments: z.array(deploymentSchema).min(1).max(100),
      }).loose()),
    );
    const active = response.result.deployments[0];
    const versionId = active?.versions.find((version) => version.percentage === 100)?.version_id;
    if (versionId === undefined) {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    return versionId;
  }

  /** Checks whether a previously uploaded Worker still exists without downloading its code. */
  public async workerExists(workerName: string): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetcher(
        new URL(
          `/client/v4/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
          API_ORIGIN,
        ),
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.accessToken}`,
          },
          redirect: "manual",
        },
      );
    } catch {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new CloudflareProvisioningError(
        response.status >= 500 ? "cloudflare_unavailable" : "cloudflare_rejected",
        response.status >= 500 ? 503 : 409,
      );
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response, 65_536);
    } catch {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    if (!apiEnvelopeSchema(z.object({}).loose()).safeParse(payload).success) {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    return true;
  }

  /** Promotes one already-uploaded Worker version atomically to all traffic. */
  public async promoteVersion(workerName: string, versionId: string): Promise<string> {
    const deployed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${workerName}/deployments`,
      apiEnvelopeSchema(z.object({ id: uuidSchema }).loose()),
      {
        method: "POST",
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: versionId }],
          annotations: { "workers/message": `Promote Later Gator version ${versionId}` },
        }),
      },
    );
    return deployed.result.id;
  }

  /** Adds a new version at zero traffic so a version override can smoke-test it. */
  public async stageVersion(
    workerName: string,
    currentVersionId: string,
    candidateVersionId: string,
  ): Promise<string> {
    const deployed = await cloudflareJson(
      this.fetcher,
      this.accessToken,
      `/client/v4/accounts/${this.accountId}/workers/scripts/${workerName}/deployments`,
      apiEnvelopeSchema(z.object({ id: uuidSchema }).loose()),
      {
        method: "POST",
        body: JSON.stringify({
          strategy: "percentage",
          versions: [
            { percentage: 100, version_id: currentVersionId },
            { percentage: 0, version_id: candidateVersionId },
          ],
          annotations: { "workers/message": `Stage Later Gator version ${candidateVersionId}` },
        }),
      },
    );
    return deployed.result.id;
  }

  /** Reads only the runtime's public privacy-safe health contract. */
  public async health(
    workerOrigin: string,
    versionOverride?: { workerName: string; versionId: string },
  ): Promise<SystemHealth> {
    let response: Response;
    try {
      response = await this.fetcher(new URL("/health", workerOrigin), {
        headers: {
          accept: "application/json",
          ...(versionOverride === undefined ? {} : {
            "Cloudflare-Workers-Version-Overrides":
              `${versionOverride.workerName}="${versionOverride.versionId}"`,
          }),
        },
        redirect: "manual",
      });
    } catch {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    if (!response.ok) {
      if (response.status === 404 && await isSameZoneWorkerFetchBlock(response)) {
        throw new CloudflareProvisioningError("cloudflare_worker_fetch_blocked", 409);
      }
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response, 65_536);
    } catch {
      throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    }
    const parsed = systemHealthSchema.safeParse(payload);
    if (!parsed.success) throw new CloudflareProvisioningError("cloudflare_unavailable", 503);
    return parsed.data;
  }
}
