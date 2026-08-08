-- Career and aspiration were two required free-text fields that the organizer
-- was explicitly told not to infer topics from. A single personalization field
-- says everything they said, without asking twice at setup.
--
-- Both columns are NOT NULL with no default, so they have to go rather than be
-- left unwritten: an insert that omitted them would fail.
ALTER TABLE profile DROP COLUMN career_context;
ALTER TABLE profile DROP COLUMN aspiration_context;

UPDATE app_state
   SET schema_version = 12,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
