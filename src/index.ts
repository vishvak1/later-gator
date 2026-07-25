import { handleQueue, handleScheduled } from "./application/runtime-events";
import {
  credentialStatus,
  removeProviderCredential,
  saveProviderCredential,
  saveRaindropCredential,
} from "./routes/admin-credentials";
import { healthResponse } from "./routes/health";
import {
  adminStatus,
  emailTest,
  emailUnavailable,
  installationValidate,
  providerActivate,
  providerTest,
} from "./routes/admin-validation";
import {
  onboardingCheck,
  onboardingContinue,
  onboardingReset,
  onboardingStart,
} from "./routes/admin-onboarding";
import { login, logout, setupPage, setupScript } from "./routes/setup-page";
import { adminMcpContext, handleMcp } from "./routes/mcp";
import {
  continueBackfill,
  pauseAutomation,
  rebuildRegistry,
  rotateMcpSecret,
  restorePrompt,
  resumeAutomation,
  saveAutomation,
  savePrompt,
  startBackfill,
  stopBackfill,
} from "./routes/admin-settings";

const worker: ExportedHandler<Env> = {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") return healthResponse();
    const mcpMatch = /^\/mcp\/([^/]+)$/u.exec(url.pathname);
    if (
      mcpMatch !== null &&
      (request.method === "GET" || request.method === "POST" || request.method === "DELETE")
    ) {
      return handleMcp(request, env, context, mcpMatch[1] ?? "");
    }
    if (request.method === "GET" && url.pathname === "/setup") return setupPage(request, env);
    if (request.method === "GET" && url.pathname === "/setup.js") return setupScript();
    if (request.method === "POST" && url.pathname === "/setup/login") return login(request, env);
    if (request.method === "POST" && url.pathname === "/setup/logout") return logout(request, env);
    if (request.method === "GET" && url.pathname === "/admin/credentials/status") {
      return credentialStatus(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin/mcp/context") {
      return adminMcpContext(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/credentials/raindrop") {
      return saveRaindropCredential(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/credentials/provider") {
      return saveProviderCredential(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/admin/credentials/provider/remove"
    ) {
      return removeProviderCredential(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin/status") {
      return adminStatus(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/provider/test") {
      return providerTest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/provider/activate") {
      return providerActivate(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/email/test") {
      return emailTest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/email/unavailable") {
      return emailUnavailable(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/installation/validate") {
      return installationValidate(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/onboarding/check") {
      return onboardingCheck(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/onboarding/start") {
      return onboardingStart(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/onboarding/continue") {
      return onboardingContinue(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/onboarding/reset") {
      return onboardingReset(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/settings/prompt") {
      return savePrompt(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/settings/prompt/restore") {
      return restorePrompt(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/settings/automation") {
      return saveAutomation(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/automation/pause") {
      return pauseAutomation(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/automation/resume") {
      return resumeAutomation(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/backfill/start") {
      return startBackfill(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/backfill/continue") {
      return continueBackfill(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/backfill/stop") {
      return stopBackfill(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/registry/rebuild") {
      return rebuildRegistry(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/mcp/rotate") {
      return rotateMcpSecret(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    await handleScheduled(env);
  },

  async queue(batch, env) {
    await handleQueue(batch, env);
  },
};

export default worker;
