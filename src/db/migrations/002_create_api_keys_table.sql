CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash    TEXT NOT NULL UNIQUE,
    tier        TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'enterprise')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
