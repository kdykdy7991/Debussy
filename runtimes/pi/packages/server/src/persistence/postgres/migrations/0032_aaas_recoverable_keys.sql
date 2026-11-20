-- Existing hashes remain usable, but their secrets cannot be recovered.
ALTER TABLE aaas_api_keys ADD COLUMN sealed_secret jsonb;
