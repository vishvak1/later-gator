# Later Gator

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vishvak1/later-gator)

Later Gator gradually organizes the bookmarks in your Raindrop.io **Unsorted** collection. It runs privately inside your own Cloudflare account and keeps Raindrop as the only home for your bookmarks.

No terminal, coding, local installation, OpenAI key, or credit card is required for the normal setup.

## Before you start

You need:

- A free GitHub account.
- A free Cloudflare account.
- A Raindrop account and its test token.
- One private setup password containing at least 10 characters.

The source Later Gator repository must be public for Cloudflare's deployment button to work.

Start with a separate Raindrop test account. Do not test the first release on your main bookmark library.

> [!WARNING]
> Existing-account onboarding deliberately removes the account's old folder and tag organization. Later Gator does not create or check backups. Export anything you want to keep before you confirm onboarding.

## Which AI will be used?

Cloudflare Workers AI is selected by default. It needs no OpenAI, Anthropic, or other AI-provider key.

You can enter an OpenAI or Anthropic key in Later Gator during setup or later. Adding or switching an AI provider never repeats onboarding and only affects bookmarks processed afterward.

## Install Later Gator

1. Press **Deploy to Cloudflare** at the top of this page.
2. Sign in to GitHub and Cloudflare when asked.
3. Choose the GitHub repository name and Cloudflare Worker name, or accept the suggested names.
4. Create and safely save **INSTALLATION_SECRET**, your private password for the Later Gator setup page. It must contain at least 10 characters.
5. Press Cloudflare's deploy button and wait for deployment to finish.
6. Open the Worker address Cloudflare gives you and add `/setup` to the end.
7. Sign in using the **INSTALLATION_SECRET** you saved.

Cloudflare copies this public project into your GitHub account and connects future updates to that copy. It also creates Later Gator's private storage, Workers AI connection, processing queue, and schedule automatically. You do not need to fork the project first.

Later Gator generates its long machine connection secret automatically after you sign in. You never need to create, remember, or type it.

## Complete the setup page

Do these actions in order:

1. **Connect Raindrop:** enter and save the test token belonging to the Raindrop account you want Later Gator to organize.
2. **Test the AI:** keep Cloudflare Workers AI selected and run the model test. No external AI key is needed.
3. **Choose email status:** configure alert email if you already have the required Cloudflare email domain, or choose **Continue without automatic intervention alerts**.
4. **Validate installation:** this checks the connection and changes nothing in Raindrop.
5. **Check the Raindrop account:** Later Gator reads only the bookmark and folder counts and tells you whether the account is fresh or existing.
6. **Review the warning and press Start onboarding:** this is the first action that changes Raindrop.
7. If the page offers **Continue onboarding**, keep pressing it until onboarding reports complete. The process is safe to resume after closing or refreshing the page.
8. Start the faster backfill if you want the existing Unsorted pile organized sooner, or leave Later Gator to work gradually.

Saving a token, testing AI, opening ChatGPT or Claude, or waiting for the schedule never starts onboarding. Only the explicit onboarding button does that.

## What happens when you press Start onboarding?

### Fresh Raindrop account

If the account has no bookmarks and no user-created folders, Later Gator only creates its standard folders and starting tag vocabulary.

### Existing Raindrop account

Later Gator:

1. Moves all bookmarks from your own folders into **Unsorted**.
2. Removes the bookmarks' existing tags.
3. Deletes your now-empty folders.
4. Creates the Later Gator folders and starting tags.

It does not delete the bookmarks. Shared folders are left alone. The Unsorted pile is then organized gradually as Cloudflare's free allowances permit.

## After onboarding

- New bookmarks left in Unsorted are discovered approximately every 15 minutes.
- **Backfill** works through a larger existing Unsorted pile without requiring the page to stay open.
- **Need for Review** holds bookmarks that require your attention.
- The same `/setup` page lets you pause or resume automation, change the AI provider, adjust instructions, review status, and copy the private connection address for ChatGPT or Claude.
- **Generate a new connection address** replaces the machine secret automatically; you never manage the secret itself.
- If a free Cloudflare allowance is reached, Later Gator waits for the allowance to reset and continues later. It does not purchase an upgrade automatically.

## Common problems

| What you see | What to do |
|---|---|
| Setup password rejected | Use the exact `INSTALLATION_SECRET` created during Cloudflare deployment. |
| Raindrop connection rejected | Confirm the token came from the intended Raindrop account and paste it again. |
| Email cannot be configured | Select **Continue without automatic intervention alerts**. Bookmark organization can still be tested. |
| Onboarding is not available | Save the Raindrop token, pass the AI test, record the email choice, and run installation validation first. |
| Processing temporarily stops | Check `/setup`. Free-limit and provider delays normally wait and retry automatically. |
| Wrong Raindrop account is shown | Stop. Replace the token before running installation validation or onboarding. |

## Uninstall

Pause Later Gator first, then delete its Worker, queue, and KV storage from your Cloudflare dashboard. Deleting Later Gator does not delete bookmarks already organized in Raindrop and does not recreate the old folder or tag structure.

## Project documents

The user journey and product rules are in the [Product Requirements](docs/product-requirements-v5.5.md). The implementation and safety design are in the [Technical Design](docs/technical-design-v1.5.md). Maintainer security and development commands are in [SECURITY.md](SECURITY.md).
