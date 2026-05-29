-- security_rls_policies.sql
-- Fixes SEC-7 and SEC-8 from the production security audit.
--
-- Apply with: psql $DATABASE_URL -f database/security_rls_policies.sql
-- Or paste into the Supabase SQL Editor.

-- ─── SEC-7: mint_capture_profiles ─────────────────────────────────────────────
-- Table had no RLS at all — anon key queries were fully open.

ALTER TABLE IF EXISTS public.mint_capture_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own capture profiles"  ON public.mint_capture_profiles;
DROP POLICY IF EXISTS "Users can insert own capture profiles" ON public.mint_capture_profiles;
DROP POLICY IF EXISTS "Users can update own capture profiles" ON public.mint_capture_profiles;
DROP POLICY IF EXISTS "Users can delete own capture profiles" ON public.mint_capture_profiles;
DROP POLICY IF EXISTS "Service role has full access to capture profiles" ON public.mint_capture_profiles;

CREATE POLICY "Users can read own capture profiles"
  ON public.mint_capture_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own capture profiles"
  ON public.mint_capture_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own capture profiles"
  ON public.mint_capture_profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own capture profiles"
  ON public.mint_capture_profiles FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypasses RLS by default — no explicit policy needed.

-- ─── SEC-8: execution_optimization_profiles ───────────────────────────────────
-- RLS was enabled but no policy existed — anon key returned zero rows silently.

DROP POLICY IF EXISTS "Users can read own optimization profiles"  ON public.execution_optimization_profiles;
DROP POLICY IF EXISTS "Users can insert own optimization profiles" ON public.execution_optimization_profiles;
DROP POLICY IF EXISTS "Users can update own optimization profiles" ON public.execution_optimization_profiles;
DROP POLICY IF EXISTS "Users can delete own optimization profiles" ON public.execution_optimization_profiles;

CREATE POLICY "Users can read own optimization profiles"
  ON public.execution_optimization_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own optimization profiles"
  ON public.execution_optimization_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own optimization profiles"
  ON public.execution_optimization_profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own optimization profiles"
  ON public.execution_optimization_profiles FOR DELETE
  USING (auth.uid() = user_id);

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
