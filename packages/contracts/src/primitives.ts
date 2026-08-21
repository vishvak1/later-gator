import { z } from "zod";

export const contractVersionSchema = z.literal(1);
export const opaqueIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u);
export const base64UrlSchema = z.string().min(16).max(4096).regex(/^[A-Za-z0-9_-]+$/u);
export const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const isoDateSchema = z.iso.date();
export const httpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === "https:",
  "Expected an HTTPS URL",
);
