import { z } from "zod";

/** Builds a bounded Zod string schema that trims surrounding whitespace. */
const trimmedText = (maximum: number) => z.string().trim().min(1).max(maximum);
/** Builds a bounded optional text schema that converts blank input to null. */
const optionalText = (maximum: number) =>
  z.union([z.string().trim().max(maximum), z.null()]).optional();

export const completeSetupInputSchema = z.strictObject({
  relevantTags: z.array(trimmedText(64)).min(5).max(500),
  personalInstructions: optionalText(5000),
  timezone: trimmedText(100),
});

export const updatePersonalInstructionsInputSchema = z.strictObject({
  personalInstructions: z.union([z.string().trim().max(5000), z.null()]),
});

export const createBookmarkInputSchema = z.strictObject({
  url: trimmedText(8192),
  title: optionalText(1000),
  description: optionalText(5000),
  note: optionalText(10_000),
  folderId: z.string().trim().min(1).max(100).optional(),
  favorite: z.boolean().optional(),
  tags: z.array(trimmedText(64)).max(50).optional(),
  linkedUrl: optionalText(8192),
  thumbnailUrl: optionalText(8192),
  organizationPolicy: z.enum(["full", "preserve", "none"]).optional(),
});

export const updateBookmarkInputSchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    url: trimmedText(8192).optional(),
    title: z.string().trim().max(1000).optional(),
    description: optionalText(5000),
    note: optionalText(10_000),
    folderId: z.string().trim().min(1).max(100).optional(),
    favorite: z.boolean().optional(),
    tags: z.array(trimmedText(64)).max(50).optional(),
  })
  .refine(
    (value) =>
      value.url !== undefined ||
      value.title !== undefined ||
      value.description !== undefined ||
      value.note !== undefined ||
      value.folderId !== undefined ||
      value.favorite !== undefined ||
      value.tags !== undefined,
    { message: "At least one bookmark field must be supplied." },
  );

export const bookmarkListQuerySchema = z.strictObject({
  folder: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(64).optional(),
  favorite: z.enum(["true", "false"]).optional(),
  /** Only bookmarks carrying a note the owner wrote, never an AI description. */
  hasNote: z.enum(["true", "false"]).optional(),
  aiState: z
    .enum([
      "pending",
      "processing",
      "waiting_provider",
      "paused_owner",
      "complete",
      "review",
      "failed",
    ])
    .optional(),
  hostname: z.string().trim().max(255).optional(),
  q: z.string().trim().max(500).optional(),
  tags: z.string().trim().max(700).optional(),
  dateField: z.enum(["added_at", "modified_at", "source_created_at"]).optional(),
  dateFrom: z.iso.datetime({ offset: true }).optional(),
  dateTo: z.iso.datetime({ offset: true }).optional(),
  sort: z
    .enum(["added_at", "modified_at", "source_created_at", "hostname", "title"])
    .default("added_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  includeTrash: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(2048).optional(),
});

export const automationPauseInputSchema = z.strictObject({
  paused: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const createTagInputSchema = z.strictObject({
  name: trimmedText(64),
});

export const providerCandidateInputSchema = z.strictObject({
  provider: z.enum(["workers-ai", "openai", "anthropic"]),
  model: trimmedText(200),
  credential: z.string().trim().min(1).max(20_000).nullable().optional(),
});

/** Cloudflare gateway names are lowercase alphanumeric with dashes. */
const aiGatewayId = z.string().trim().max(64).regex(/^[a-z0-9-]*$/u).optional();

export const providerActivationInputSchema = z.strictObject({
  provider: z.enum(["workers-ai", "openai", "anthropic"]),
  model: trimmedText(200),
  aiGatewayId,
});

export const captureCredentialInputSchema = z.strictObject({
  kind: z.enum(["extension", "ios"]),
  name: trimmedText(100),
});

export const relationshipInputSchema = z.strictObject({
  linkedUrl: trimmedText(8192),
});

export const resetApplicationInputSchema = z.strictObject({
  confirmation: z.literal("DELETE EVERYTHING"),
});

export const thumbnailReclaimInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(1000),
});

export type CreateBookmarkInput = z.infer<typeof createBookmarkInputSchema>;
export type UpdateBookmarkInput = z.infer<typeof updateBookmarkInputSchema>;
export type BookmarkListQuery = z.infer<typeof bookmarkListQuerySchema>;
export type CompleteSetupInput = z.infer<typeof completeSetupInputSchema>;

export const backgroundMessageSchema = z.union([
  z.strictObject({
    type: z.literal("organize"),
    jobId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("reset_storage"),
  }),
  z.strictObject({
    type: z.literal("dispatch_pending"),
  }),
  z.strictObject({
    type: z.literal("embed_pending"),
  }),
]);

export type BackgroundMessage = z.infer<typeof backgroundMessageSchema>;

export const thumbnailMessageSchema = z.union([
  z.strictObject({
    type: z.literal("dispatch_thumbnail_pending"),
  }),
  z.strictObject({
    type: z.literal("thumbnail"),
    jobId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("thumbnail_storage_migration"),
    migrationId: z.uuid(),
    action: z.enum(["copy", "cleanup"]),
  }),
]);

export type ThumbnailMessage = z.infer<typeof thumbnailMessageSchema>;
