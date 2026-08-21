# Later Gator for Chrome

For the unpacked development test flow, see [TESTING.md](TESTING.md).

Save the current page directly to the Later Gator installation in your own
Cloudflare account. Continue with Cloudflare once; the extension discovers your
installation and asks Chrome for access only to its exact Worker origin.

## Permission disclosure

- `identity`: opens the Cloudflare sign-in and returns a short-lived one-time
  pairing grant to the extension.
- `storage`: keeps the personal Worker origin, a narrow revocable capture token,
  a device identifier, and non-sensitive popup preferences.
- `activeTab`, `tabs`, and `scripting`: read the current page's URL, title,
  metadata, and the individually selected links in an X thread when the owner
  opens the popup.
- optional host access: requested interactively for the exact personal Worker
  origin after installation discovery. The extension does not receive broad
  host access automatically.

The extension contains no remote executable code, deployment authorization,
Cloudflare installer token, OpenAI key, Anthropic key, or bookmark database.
