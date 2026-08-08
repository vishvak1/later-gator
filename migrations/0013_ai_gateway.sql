-- Prepaid AI Gateway credits only pay for traffic routed through a gateway:
-- Workers AI ignores them unless the request carries a gateway id. The id is a
-- deployment-level setting rather than a binding, so it cannot be provisioned
-- by the Deploy to Cloudflare button and has to be entered by the owner.
--
-- Empty means "call Workers AI directly", which is the behaviour every existing
-- deployment already has.
ALTER TABLE provider_settings ADD COLUMN ai_gateway_id TEXT;

UPDATE app_state
   SET schema_version = 13,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
