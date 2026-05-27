-- mint_contract_cache
-- Shared execution cache written by the Railway worker after a successful mint
-- detection (inline or prepareMintTransaction).  Read by the Vercel readiness
-- API on every cold start so the in-memory execCache Map can be warmed from DB.
--
-- Unique key: (contract_address, chain) — one config per contract per chain.
-- upsert with onConflict: 'contract_address,chain' updates the row in place.

CREATE TABLE IF NOT EXISTS public.mint_contract_cache (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_address text        NOT NULL,
  chain            text        NOT NULL,
  function_name    text,
  args_summary     jsonb       DEFAULT '[]',
  gas_estimate     text,
  success_count    integer     DEFAULT 1,
  last_latency_ms  integer,
  last_success_at  timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  CONSTRAINT mint_contract_cache_contract_chain_unique
    UNIQUE (contract_address, chain)
);

-- Index for the primary lookup pattern: contract + chain
CREATE INDEX IF NOT EXISTS mint_contract_cache_lookup_idx
  ON public.mint_contract_cache (contract_address, chain);

-- Enable RLS (service_role bypasses automatically; authenticated role gets no access by default)
ALTER TABLE public.mint_contract_cache ENABLE ROW LEVEL SECURITY;

-- Grant full access to service_role (used by both the Railway worker and Vercel functions)
GRANT ALL ON public.mint_contract_cache TO service_role;

-- Allow the authenticated role to read (used by client-side readiness checks, if any)
GRANT SELECT ON public.mint_contract_cache TO authenticated;

-- Service role bypass policy (PostgREST requires an explicit policy even for service_role when RLS is enabled)
CREATE POLICY "service_role_all" ON public.mint_contract_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION public.mint_contract_cache_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mint_contract_cache_updated_at ON public.mint_contract_cache;
CREATE TRIGGER mint_contract_cache_updated_at
  BEFORE UPDATE ON public.mint_contract_cache
  FOR EACH ROW EXECUTE FUNCTION public.mint_contract_cache_set_updated_at();
