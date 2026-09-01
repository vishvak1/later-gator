/**
 * Every how-to lives here once. The dashboard overlay walks all of them with
 * left/right navigation; Settings opens the same markup filtered to one panel,
 * so the two can never drift apart.
 */
export const HOW_TO_PANELS: readonly { id: string; kicker: string; title: string; body: string }[] = [
  {
    id: "chrome",
    kicker: "Browser extension",
    title: "Save from Chrome",
    body: `<p class="muted">The extension is loaded from your own copy of the repository and talks only to your deployment.</p>
      <ol class="setup-steps">
        <li><strong>Open extensions.</strong><span>Go to <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.</span></li>
        <li><strong>Load it.</strong><span>Choose <strong>Load unpacked</strong> and select the <code>extension/chrome</code> folder.</span></li>
        <li><strong>Connect once.</strong><span>In Settings, generate a connection code, click the toolbar icon, paste it, and select Connect.</span></li>
      </ol>
      <figure class="guide-figure">
        <img src="/img/chrome-devmode.png" alt="Chrome extensions page with Developer mode enabled and the Load unpacked button highlighted" loading="lazy" width="966" height="704">
        <figcaption>Developer mode, then Load unpacked.</figcaption>
      </figure>`,
  },
  {
    id: "ios",
    kicker: "iOS Share Sheet",
    title: "Save from your iPhone",
    body: `<p class="muted">A Shortcut receives one shared link and saves it straight to Unsorted.</p>
      <ol class="setup-steps">
        <li><strong>Generate the connection.</strong><span>In Settings, copy the endpoint and token. The token is shown only once.</span></li>
        <li><strong>Add the Shortcut.</strong><span>Select <strong>Add to Shortcuts</strong> in Settings. Shortcuts asks for your endpoint and token once during install — nothing to edit afterwards.</span></li>
        <li><strong>Enable it in the Share Sheet.</strong><span>Share any page, scroll to the bottom, choose <strong>Edit Actions</strong>, and turn on <strong>Add To Unsorted</strong>.</span></li>
        <li><strong>Save anything.</strong><span>Share from Safari, X, or any app and pick Add To Unsorted.</span></li>
      </ol>
      <div class="guide-figure-row">
        <figure class="guide-figure tall">
          <img src="/img/ios-edit-actions.png" alt="iOS share sheet scrolled to the bottom with Edit Actions highlighted" loading="lazy">
          <figcaption>Scroll down, tap Edit Actions.</figcaption>
        </figure>
        <figure class="guide-figure tall">
          <img src="/img/ios-add-unsorted.png" alt="iOS Edit Actions list with the Add To Unsorted toggle enabled" loading="lazy">
          <figcaption>Turn on Add To Unsorted.</figcaption>
        </figure>
        <figure class="guide-figure tall">
          <img src="/img/ios-sharesheet.jpg" alt="iOS share sheet showing Add To Unsorted among the available actions" loading="lazy">
          <figcaption>It now appears when you share.</figcaption>
        </figure>
      </div>`,
  },
  {
    id: "mcp",
    kicker: "MCP",
    title: "Connect Codex or Claude Code",
    body: `<p class="muted">Later Gator uses OAuth, so you never copy a secret token or enable a developer mode. Each command installs the remote server and immediately starts browser login.</p>
      <h3>Codex</h3>
      <ol class="setup-steps">
        <li><strong>Copy the Codex command.</strong><span>Paste it into a terminal that has the Codex CLI installed.</span></li>
        <li><strong>Finish browser login.</strong><span>The command opens Later Gator. Sign in through Cloudflare if needed, then approve read-only access. The original login resumes automatically.</span></li>
        <li><strong>Confirm it.</strong><span>Run <code>codex mcp list</code>, then ask Codex: <code>Use Later Gator to get my library status.</code></span></li>
      </ol>
      <h3>Claude Code</h3>
      <ol class="setup-steps">
        <li><strong>Copy the Claude command.</strong><span>Paste it into a terminal with the current Claude Code CLI. The user scope makes the server available across your projects.</span></li>
        <li><strong>Finish browser login.</strong><span>Sign in through Cloudflare if needed and approve read-only access; you do not need to run a separate login command.</span></li>
        <li><strong>Confirm it.</strong><span>Run <code>claude mcp list</code>, then ask Claude Code to get your Later Gator library status.</span></li>
      </ol>
      <p class="muted">If an older Claude Code version does not recognize <code>claude mcp login</code>, update Claude Code or open Claude Code and use <code>/mcp</code> to finish authentication.</p>
      <p class="muted"><strong>If the browser was signed out:</strong> the same command takes you through Cloudflare sign-in and returns to the pending MCP approval. If it expired, run the copied command again.</p>
      <p class="muted"><strong>To remove access:</strong> return to Settings and select Disconnect beside that client. Other connected clients keep working.</p>`,
  },
  {
    id: "models",
    kicker: "AI provider",
    title: "Change the model",
    body: `<p class="muted">Later Gator can organize with Cloudflare Workers AI, or with your own OpenAI or Anthropic key. The model is set in Settings, never in the Cloudflare dashboard.</p>
      <ol class="setup-steps">
        <li><strong>Pick a model.</strong><span>Browse <a href="https://developers.cloudflare.com/workers-ai/models/?tasks=Text+Generation" target="_blank" rel="noreferrer">Cloudflare's text generation models ↗</a>.</span></li>
        <li><strong>Copy the model ID.</strong><span>Use the copy button beside the id — it always starts with <code>@cf/</code>.</span></li>
        <li><strong>Paste it into Settings.</strong><span>Under AI provider, choose Cloudflare Workers AI, paste the id into Model, and select Test and activate. A model that does not support structured output fails the test and is never activated.</span></li>
        <li><strong>Or bring your own key.</strong><span>Choose OpenAI or Anthropic instead and paste an API key with the provider's own model name.</span></li>
      </ol>
      <figure class="guide-figure">
        <img src="/img/cf-model.png" alt="Cloudflare Workers AI model page for gpt-oss-120b showing the @cf/openai/gpt-oss-120b model id with a copy button" loading="lazy" width="900">
        <figcaption>Copy the <code>@cf/…</code> id from the model page.</figcaption>
      </figure>
      <h3>Which models are free?</h3>
      <p class="muted">Workers AI includes <strong>10,000 Neurons per day at no charge</strong>, shared across every model rather than allocated per model. Neurons measure GPU work, so a model's cost per bookmark depends on its rate — the per-model input and output rates are listed on <a href="https://developers.cloudflare.com/workers-ai/platform/pricing/" target="_blank" rel="noreferrer">the Workers AI pricing page ↗</a>. Output tokens usually cost several times more than input.</p>
      <p class="muted">Almost every model draws from that free allocation. A small number are excluded and need a Workers Paid plan; the pricing page marks them. When the daily allocation runs out, organization pauses and resumes the next day rather than failing.</p>
      <h3>Going past the free allocation</h3>
      <p class="muted">Searching costs Neurons too, not only saving: every search turns your words into a vector through Workers AI. So when the daily allocation is spent, semantic search quietly falls back to plain keyword matching until it resets.</p>
      <p class="muted">Prepaid <strong>AI Gateway credits</strong> lift that ceiling without a monthly subscription, and also cover OpenAI, Anthropic and Google without holding their API keys. Credits are only spent on traffic routed through a gateway, so Later Gator has to send the gateway ID with every call.</p>
      <ol class="setup-steps">
        <li><strong>Create a gateway.</strong><span>In the Cloudflare dashboard open <strong>AI</strong> → <strong>AI Gateway</strong> and create one. Naming it <code>later-gator-ai-gateway</code> keeps it obvious later.</span></li>
        <li><strong>Switch its billing to Unified billing.</strong><span>In the gateway's settings, set <strong>Workers AI billing</strong> to <strong>Unified billing</strong>. Without this, credits are never spent.</span></li>
        <li><strong>Add credits.</strong><span>Buy any one-time amount on the AI Gateway page. A 5% fee applies to the purchase; inference itself is charged at the standard rate with no markup.</span></li>
        <li><strong>Tell Later Gator.</strong><span>In Settings, open <strong>Advanced</strong> beside Test and activate, paste the gateway ID, and save. Leaving it empty keeps calling Workers AI directly on the free allocation.</span></li>
      </ol>
      <p class="muted">Cloudflare cannot create a gateway from the Deploy to Cloudflare button, so this step is manual. Once the ID is saved it applies to both organizing and search embeddings.</p>`,
  },
];
