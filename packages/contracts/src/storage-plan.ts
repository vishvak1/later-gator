import { z } from "zod";
import {
  base64UrlSchema,
  contractVersionSchema,
  httpsUrlSchema,
  isoDateSchema,
} from "./primitives";
import { thumbnailStorageVariantSchema } from "./installation";

export const storagePlanFactSchema = z
  .object({
    storageVariant: thumbnailStorageVariantSchema,
    title: z.string().min(1).max(100),
    summary: z.string().min(1).max(500),
    billingProfileMayBeRequired: z.boolean(),
    informationalAllowances: z.array(z.string().min(1).max(240)).max(10),
    officialUrls: z.array(httpsUrlSchema).min(1).max(5),
  })
  .strict();

export const storagePlanCatalogSchema = z
  .object({
    contractVersion: contractVersionSchema,
    revision: z.number().int().positive(),
    reviewedOn: isoDateSchema,
    disclaimer: z.string().min(1).max(500),
    plans: z.array(storagePlanFactSchema).length(3),
    signingKeyId: z.string().min(1).max(128),
    signature: base64UrlSchema,
  })
  .strict();

export type StoragePlanCatalog = z.infer<typeof storagePlanCatalogSchema>;
