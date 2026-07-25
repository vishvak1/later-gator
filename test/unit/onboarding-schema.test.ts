import { describe, expect, it } from "vitest";
import {
  EncryptedCredentialStateSchema,
  OnboardingStateSchema,
} from "../../src/domain/schemas";

describe("revised onboarding contracts", () => {
  it("accepts the simplified existing-account progress state", () => {
    expect(
      OnboardingStateSchema.parse({
        schemaVersion: 1,
        status: "in_progress",
        accountUserId: 42,
        mode: "existing",
        currentStep: "clear_tags",
        startedAt: "2026-07-25T00:00:00.000Z",
        completedAt: null,
        cursor: "0",
        folderIds: {},
        seedVersion: "v1",
        revision: 1,
      }),
    ).toMatchObject({ mode: "existing", currentStep: "clear_tags" });
  });

  it("rejects removed backup and plan fields", () => {
    expect(() =>
      OnboardingStateSchema.parse({
        schemaVersion: 1,
        status: "not_started",
        accountUserId: null,
        mode: null,
        currentStep: null,
        startedAt: null,
        completedAt: null,
        cursor: null,
        folderIds: {},
        seedVersion: null,
        revision: 0,
        planId: "obsolete",
        backupAcknowledgedAt: "2026-07-25T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("stores only encrypted credential envelopes", () => {
    const state = EncryptedCredentialStateSchema.parse({
      schemaVersion: 1,
      salt: "deployment-salt",
      raindrop: {
        algorithm: "AES-GCM",
        keyDerivation: "HKDF-SHA-256",
        nonce: "unique-nonce",
        ciphertext: "encrypted-value",
        updatedAt: "2026-07-25T00:00:00.000Z",
      },
      anthropic: null,
      openai: null,
      mcpPath: null,
      revision: 1,
    });

    expect(state.raindrop).not.toHaveProperty("plaintext");
  });
});
