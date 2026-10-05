# Test the personal Chrome extension

Run `npm run build:extensions`, then open `chrome://extensions`, enable Developer
mode and load this repository's `extension/chrome` folder unpacked.

Use a disposable instance until the production-library gates pass:

1. Sign in directly to the instance and open Settings.
2. Generate a browser connection code and paste it into the extension popup.
3. Approve Chrome access to that exact instance origin.
4. Save a page and check it appears in the library.
5. Test X per-link choices, duplicate review, Go back, Cancel, and successful save.
6. Disconnect the device in Settings and verify capture is rejected.
7. Confirm temporary outages preserve the existing connection for retry.

The optional host permission ceiling supports HTTPS workers.dev instances and
HTTP localhost development. A custom domain requires explicitly adding its
origin to `optional_host_permissions` before rebuilding.

After source edits, rebuild and select Reload in Chrome. No public store,
identity callback registration, or management service is required.
