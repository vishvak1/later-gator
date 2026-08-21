import { opaqueIdSchema } from "@later-gator/contracts";
import { z } from "zod";

const runtimeIdentityConfigSchema = z
  .object({
    PUBLIC_ORIGIN: z.url(),
    CONTROL_PLANE_ORIGIN: z.url(),
    INSTALLATION_ID: opaqueIdSchema,
  })
  .strict();

export interface RuntimeIdentityConfig {
  publicOrigin: string;
  controlPlaneOrigin: string;
  installationId: string;
}

/** Validates the installation identity and fixed public origins used during owner login. */
export function readRuntimeIdentityConfig(env: Env): RuntimeIdentityConfig {
  const parsed = runtimeIdentityConfigSchema.safeParse({
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
    CONTROL_PLANE_ORIGIN: env.CONTROL_PLANE_ORIGIN,
    INSTALLATION_ID: env.INSTALLATION_ID,
  });
  if (!parsed.success) throw new Error("runtime_identity_config_unavailable");
  const publicOrigin = new URL(parsed.data.PUBLIC_ORIGIN);
  const controlPlaneOrigin = new URL(parsed.data.CONTROL_PLANE_ORIGIN);
  for (const origin of [publicOrigin, controlPlaneOrigin]) {
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      throw new Error("runtime_identity_config_unavailable");
    }
  }
  return {
    publicOrigin: publicOrigin.origin,
    controlPlaneOrigin: controlPlaneOrigin.origin,
    installationId: parsed.data.INSTALLATION_ID,
  };
}
