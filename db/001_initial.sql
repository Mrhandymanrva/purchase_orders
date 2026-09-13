CREATE TABLE IF NOT EXISTS app_state (
 id integer PRIMARY KEY CHECK (id = 1),
 payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_tokens(provider text PRIMARY KEY, payload text NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (
 state_hash text PRIMARY KEY,
 browser_hash text NOT NULL,
 actor text NOT NULL,
 environment text NOT NULL,
 client_fingerprint text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS audit_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 id text NOT NULL UNIQUE,
 at timestamptz NOT NULL,
 actor text NOT NULL,
 action text NOT NULL,
 detail jsonb NOT NULL,
 previous_hash text NOT NULL,
 hash text NOT NULL UNIQUE
);
CREATE OR REPLACE FUNCTION deny_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append only'; END; $$;
DROP TRIGGER IF EXISTS audit_immutable ON audit_events;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION deny_audit_mutation();
