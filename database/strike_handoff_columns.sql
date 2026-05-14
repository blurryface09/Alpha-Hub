-- Alpha Hub Strike Mode handoff compatibility.
-- Run in Supabase SQL editor if Strike Mode arms but the worker does not pick it up.

alter table if exists public.mint_intents
  add column if not exists strike_status text default 'idle',
  add column if not exists strike_execute_at timestamptz,
  add column if not exists vault_wallet_id uuid,
  add column if not exists strike_enabled boolean default false,
  add column if not exists max_gas_fee numeric,
  add column if not exists quantity integer default 1;

create index if not exists mint_intents_strike_worker_idx
  on public.mint_intents (strike_enabled, status, strike_execute_at, updated_at);

create index if not exists mint_intents_vault_wallet_idx
  on public.mint_intents (vault_wallet_id);
