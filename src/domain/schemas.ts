import { z } from "zod";
import { CONTENT_FOLDER_NAMES, FOLDER_NAMES } from "./seed";

export const ProviderNameSchema = z.enum(["workers-ai", "anthropic", "openai"]);
export const FolderNameSchema = z.enum(FOLDER_NAMES);
export const ContentFolderNameSchema = z.enum(CONTENT_FOLDER_NAMES);
export const EmailStatusSchema = z.enum([
  "ready",
  "needs_domain",
  "needs_verification",
  "unavailable",
]);

export const InstallationStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    configurationFingerprint: z.string().min(1),
    provider: ProviderNameSchema,
    model: z.string().min(1),
    raindropUserId: z.number().int().positive(),
    bindingsValid: z.boolean(),
    providerValid: z.boolean(),
    emailStatus: EmailStatusSchema,
    validatedAt: z.iso.datetime(),
  })
  .strict();

export const ProviderChoiceSchema = z
  .object({
    provider: ProviderNameSchema,
    model: z.string().trim().min(1).max(200),
    promptRevision: z.number().int().positive(),
  })
  .strict();

export const ProviderConfigStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    active: ProviderChoiceSchema,
    candidate: ProviderChoiceSchema.nullable(),
    candidateTestedAt: z.iso.datetime().nullable(),
    candidateTestSucceeded: z.boolean(),
    personalInstructions: z.string().max(4_000),
    fullPromptOverride: z.string().max(20_000).nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const EmailConfigStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    recipient: z.email().nullable(),
    from: z.email().nullable(),
    status: EmailStatusSchema,
    testSentAt: z.iso.datetime().nullable(),
    lastDeliveryAt: z.iso.datetime().nullable(),
    lastDeliveryCode: z.string().max(100).nullable(),
    lastAlertPauseRevision: z.number().int().nonnegative().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const OnboardingStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["not_started", "in_progress", "complete"]),
    accountUserId: z.number().int().positive().nullable(),
    mode: z.enum(["fresh", "existing"]).nullable(),
    currentStep: z
      .enum([
        "move_to_unsorted",
        "clear_tags",
        "delete_collections",
        "create_folders",
        "initialize_registry",
        "complete",
      ])
      .nullable(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    cursor: z.string().max(1_000).nullable(),
    folderIds: z.partialRecord(FolderNameSchema, z.number().int().positive()),
    seedVersion: z.string().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const RegistryEntrySchema = z
  .object({
    count: z.number().int().nonnegative(),
    firstUsedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
  })
  .strict();

export const RegistryStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    seedVersion: z.string().min(1).max(50),
    tags: z.record(z.string().min(1).max(100), RegistryEntrySchema),
    attempts: z.record(
      z.string().regex(/^\d+$/u),
      z
        .object({
          count: z.number().int().positive(),
          lastReason: z.string().max(200),
          lastAttemptAt: z.iso.datetime(),
        })
        .strict(),
    ),
    updatedAt: z.iso.datetime(),
    source: z.enum(["onboarding", "automation", "resync"]),
  })
  .strict();

export const OrganizationResultSchema = z
  .object({
    tags: z.array(z.string()).min(1).max(8),
    description: z.string().min(1).max(1_000),
    folder: ContentFolderNameSchema,
    confidence: z.enum(["high", "medium", "low"]),
    notes: z.string().max(1_000).nullable(),
  })
  .strict();

export const EncryptedValueSchema = z
  .object({
    algorithm: z.literal("AES-GCM"),
    keyDerivation: z.literal("HKDF-SHA-256"),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const EncryptedCredentialStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    salt: z.string().min(1),
    raindrop: EncryptedValueSchema.nullable(),
    anthropic: EncryptedValueSchema.nullable(),
    openai: EncryptedValueSchema.nullable(),
    mcpPath: EncryptedValueSchema.nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const PipelineStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["scheduled", "backfill"]),
    paused: z.boolean(),
    pauseReason: z.string().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    deferredUntil: z.iso.datetime().nullable(),
    deferredReason: z
      .enum(["raindrop_rate_limit", "provider_rate_limit", "workers_ai_daily_budget"])
      .nullable(),
    backfillSessionId: z.string().max(100).nullable(),
    lastRun: z
      .object({
        runId: z.string().min(1).max(100),
        source: z.enum(["queue", "backfill"]),
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime(),
        selected: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
        reviewed: z.number().int().nonnegative(),
        deferred: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    systemicFailureStreak: z
      .object({
        provider: z
          .enum(["raindrop", "workers_ai", "anthropic", "openai", "cloudflare_email"])
          .nullable(),
        distinctBookmarkIds: z.array(z.number().int().positive()).max(10),
        code: z.string().max(100).nullable(),
      })
      .strict(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const DispatchMessageSchema = z
  .object({
    bookmarkId: z.number().int().positive(),
    raindropUserId: z.number().int().positive(),
    dispatchRevision: z.string().min(1).max(100),
    enqueuedAt: z.iso.datetime(),
    source: z.enum(["queue", "backfill"]).default("queue"),
  })
  .strict();

export const DispatchStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    leases: z.record(
      z.string().regex(/^\d+$/u),
      z
        .object({
          dispatchRevision: z.string().min(1).max(100),
          expiresAt: z.iso.datetime(),
        })
        .strict(),
    ),
    lastDiscoveryAt: z.iso.datetime().nullable(),
    lastDiscovered: z.number().int().nonnegative(),
    lastEnqueued: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const AiUsageStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    utcDate: z.iso.date(),
    estimatedNeurons: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    lastUpdatedAt: z.iso.datetime(),
  })
  .strict();

export const AutomationConfigStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    dispatchLimit: z.number().int().min(1).max(50),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const MaintenanceStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastRegistryResyncAt: z.iso.datetime().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const ActivityEntrySchema = z
  .object({
    at: z.iso.datetime(),
    event: z.string().min(1).max(100),
    outcome: z.string().min(1).max(100),
    bookmarkId: z.number().int().positive().optional(),
  })
  .strict();

export const ActivityStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(ActivityEntrySchema).max(50),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export type InstallationState = z.infer<typeof InstallationStateSchema>;
export type ProviderChoice = z.infer<typeof ProviderChoiceSchema>;
export type ProviderConfigState = z.infer<typeof ProviderConfigStateSchema>;
export type EmailConfigState = z.infer<typeof EmailConfigStateSchema>;
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
export type RegistryState = z.infer<typeof RegistryStateSchema>;
export type FolderName = z.infer<typeof FolderNameSchema>;
export type ContentFolderName = z.infer<typeof ContentFolderNameSchema>;
export type OrganizationResult = z.infer<typeof OrganizationResultSchema>;
export type EncryptedCredentialState = z.infer<typeof EncryptedCredentialStateSchema>;
export type PipelineState = z.infer<typeof PipelineStateSchema>;
export type DispatchMessage = z.infer<typeof DispatchMessageSchema>;
export type DispatchState = z.infer<typeof DispatchStateSchema>;
export type AiUsageState = z.infer<typeof AiUsageStateSchema>;
export type AutomationConfigState = z.infer<typeof AutomationConfigStateSchema>;
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type ActivityState = z.infer<typeof ActivityStateSchema>;
