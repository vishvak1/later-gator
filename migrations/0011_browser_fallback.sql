-- Browser rendering is a fallback tier for pages whose content is painted by
-- client-side script. It never changes an outcome the cheap path already
-- reached; it only gets one attempt at a page the cheap path could not read.
--
-- browser_rendered_at scopes that attempt to a single organization job, so a
-- re-queued retry cannot render the same page twice while a genuine
-- re-organization still gets a fresh chance.
ALTER TABLE background_jobs ADD COLUMN browser_rendered_at TEXT;

-- Cloudflare meters browser time per UTC day and answers 429 once it is spent.
-- Recording that answer stops the Worker asking again until the day rolls over.
ALTER TABLE app_state ADD COLUMN browser_blocked_until TEXT;

UPDATE app_state
   SET schema_version = 11,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
