# Test the Chrome extension before store submission

The unpacked extension can exercise the real development control plane and the
personal Worker without publishing anything to the Chrome Web Store.

## 1. Build for the development control plane

From the repository root, install locked dependencies and run the extension
tests before generating the unpacked folder:

```bash
npm ci
npm run check --workspace @later-gator/chrome-extension
LATER_GATOR_CONTROL_PLANE_ORIGIN=https://later-gator-control-plane-dev.vishvak-v.workers.dev npm run build --workspace @later-gator/chrome-extension
```

Load `/absolute/path/to/later-gator/extension/chrome`, not the ZIP archive. The
ZIP is the later store-submission artifact.

## 2. Load the unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this repository's `extension/chrome`
   directory.
4. Copy the 32-character extension ID shown on the Later Gator card.

Chrome's unpacked ID is part of the pairing callback. Before the first pairing
test, add that exact ID to the comma-separated `CHROME_EXTENSION_IDS` value in
`apps/control-plane/wrangler.dev.jsonc`, validate, and redeploy only the
development control plane. Do not add a wildcard callback or broad extension
allowlist.

## 3. Exercise the product flow

1. Pin Later Gator from Chrome's Extensions menu.
2. Visit a normal HTTPS page and open the Later Gator popup.
3. Select **Continue with Cloudflare**, complete Cloudflare authorization, and
   approve Chrome's request for the exact personal `workers.dev` origin.
4. Save a normal page and confirm it appears in the personal Later Gator app.
5. Open an X post containing more than one link. Verify the group checkbox and
   per-link checkboxes, then test **Go back**, **Cancel**, duplicate-link review,
   and a successful save.
6. Revoke the device in Later Gator, reopen the popup, and confirm that it asks
   to reconnect instead of retaining access.
7. In `chrome://extensions`, inspect the extension service worker and popup
   console for errors; personal Worker retrieval diagnostics remain in that
   owner's Cloudflare Worker logs.

After source changes, rerun the development build and select the extension's
**Reload** button in `chrome://extensions`. Rebuilding with no origin override
returns the generated folder to the production `https://latergator.app`
configuration.
