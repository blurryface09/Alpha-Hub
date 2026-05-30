-- security_rls_policies.sql
-- Fixes VAULT-1/2 and SCALE-2 from the production security audit.
--
-- Apply with: psql $DATABASE_URL -f database/security_rls_policies.sql
-- Or paste into the Supabase SQL Editor.
--
-- Note: mint_capture_profiles and execution_optimization_profiles sections
-- omitted — neither table is present in this schema.

-- ─── VAULT-1+VAULT-2: Encryption key versioning ──────────────────────────────
-- Adds key_version column so vaults encrypted with an older key can still be
-- decrypted after a key rotation. Existing rows default to version 1.

ALTER TABLE IF EXISTS public.alpha_vault_wallets
  ADD COLUMN IF NOT EXISTS key_version INTEGER NOT NULL DEFAULT 1;

-- ─── SCALE-2: Worker polling index ────────────────────────────────────────────
-- The worker polls mint_intents every 2 seconds. Without this index the query
-- does a sequential scan on the full table.

CREATE INDEX IF NOT EXISTS mint_intents_worker_poll_idx
  ON public.mint_intents (strike_enabled, status, updated_at ASC)
  WHERE strike_enabled = true;
