-- Existing extension connections gain the narrow bookmark-search capability.
-- iOS credentials do not have capture:options and are intentionally unchanged.
UPDATE capture_credentials
   SET scopes = json_insert(scopes, '$[#]', 'capture:bookmark-search')
 WHERE revoked_at IS NULL
   AND json_valid(scopes)
   AND EXISTS (
     SELECT 1 FROM json_each(capture_credentials.scopes)
      WHERE value = 'capture:options'
   )
   AND NOT EXISTS (
     SELECT 1 FROM json_each(capture_credentials.scopes)
      WHERE value = 'capture:bookmark-search'
   );
