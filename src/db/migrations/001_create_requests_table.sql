CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS requests (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id         TEXT NOT NULL,
    feature_id         TEXT NOT NULL,
    provider           TEXT NOT NULL,
    tier               TEXT NOT NULL,
    prompt_tokens      INTEGER NOT NULL,
    completion_tokens  INTEGER NOT NULL,
    cost_usd           NUMERIC(12, 6) NOT NULL,
    latency_ms         INTEGER NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_api_key_id_idx ON requests (api_key_id);
CREATE INDEX IF NOT EXISTS requests_created_at_idx ON requests (created_at);
