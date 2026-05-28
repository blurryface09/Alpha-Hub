-- mint_contract_cache
-- Shared execution cache written by the Railway worker after a successful mint
-- detection. Read by the Vercel readiness API to warm the in-memory execCache
-- on cold starts. Unique key: (contract_address, chain).

CREATE TABLE IF NOT EXISTS public.mint_contract_cache (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address text        NOT NULL,
  chain            text        NOT NULL,
  function_name    text,
  args_summary     jsonb       DEFAULT '[]'::jsonb,
  gas_estimate     text,
  success_count    integer     DEFAULT 1,
  last_latency_ms  integer,
  last_success_at  timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE (contract_address, chain)
);

CREATE INDEX IF NOT EXISTS idx_mint_contract_cache_lookup
  ON public.mint_contract_cache (contract_address, chain);

ALTER TABLE public.mint_contract_cache ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.mint_contract_cache TO service_role;
GRANT SELECT ON public.mint_contract_cache TO authenticated;

CREATE POLICY "service_role_all" ON public.mint_contract_cache
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
