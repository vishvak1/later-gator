-- Capture surfaces that read a live browser DOM (the extension) can only offer
-- a hint: single-page sites leave stale og:image tags in the document after a
-- client-side navigation, so every post captured that way shares one cover.
-- The hint is now stored on the job and tried only after server-side discovery.
ALTER TABLE thumbnail_jobs ADD COLUMN candidate_url TEXT;

UPDATE app_state
   SET schema_version = 10,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
