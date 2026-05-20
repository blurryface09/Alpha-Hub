-- Alpha Hub v2: Alpha Radar + Mint Engine + Alpha Vault.
-- Safe to paste in Supabase SQL editor. No triggers/functions.

alter table if exists public.calendar_projects add column if not exists mint_phase text default 'unknown';
alter table if exists public.calendar_projects add column if not exists source_timezone text;
alter table if exists public.calendar_projects add column if not exists recommended_mode text default 'safe';
alter table if exists public.calendar_projects add column if not exists supply text;
alter table if exists public.calendar_projects add column if not exists price_value numeric;
alter table if exists public.calendar_projects add column if not exists price_currency text;
alter table if exists public.calendar_projects add column if not exists price_label text;
alter table if exists public.calendar_projects add column if not exists price_note text;
alter table if exists public.calendar_projects add column if not exists price_confidence text;
alter table if exists public.calendar_projects add column if not exists stage_prices jsonb;
alter table if exists public.calendar_projects add column if not exists mint_schedule jsonb;
alter table if exists public.calendar_projects add column if not exists mint_status text;
alter table if exists public.calendar_projects add column if not exists mint_end_date timestamptz;
alter table if exists public.calendar_projects add column if not exists source_metadata jsonb;

create table if not exists public.alpha_vault_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  address text not null,
  label text default 'Alpha Vault',
  chain_scope text default 'evm',
  encrypted_private_key text not null,
  status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, address)
);

create table if not exists public.mint_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid,
  calendar_project_id uuid,
  wl_project_id uuid,
  project_name text,
  contract_address text,
  chain text default 'eth',
  chain_id integer default 1,
  mint_url text,
  mint_phase text default 'unknown',
  execution_mode text default 'safe',
  quantity integer default 1,
  max_mint_price text,
  max_gas_fee text,
  max_total_spend text,
  strike_enabled boolean default false,
  prepared_to text,
  prepared_data text,
  prepared_value text,
  prepared_chain_id integer,
  simulation_status text,
  simulation_error text,
  last_state text,
  tx_resilience_state text,
  replacement_tx_hash text,
  last_nonce integer,
  status text default 'draft',
  tx_hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.mint_attempts (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.mint_intents(id) on delete cascade,
  mint_intent_id uuid,
  user_id uuid not null,
  status text default 'queued',
  tx_hash text,
  error_message text,
  metadata jsonb default '{}'::jsonb,
  gas_used numeric,
  rpc_label text,
  latency_ms numeric,
  confirmation_ms numeric,
  function_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.mint_attempts add column if not exists mint_intent_id uuid;
alter table public.mint_attempts add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.mint_attempts add column if not exists gas_used numeric;
alter table public.mint_attempts add column if not exists rpc_label text;
alter table public.mint_attempts add column if not exists latency_ms numeric;
alter table public.mint_attempts add column if not exists confirmation_ms numeric;
alter table public.mint_attempts add column if not exists function_name text;
alter table public.mint_intents add column if not exists tx_resilience_state text;
alter table public.mint_intents add column if not exists replacement_tx_hash text;
alter table public.mint_intents add column if not exists last_nonce integer;

create table if not exists public.mint_execution_events (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.mint_intents(id) on delete cascade,
  user_id uuid not null,
  state text not null,
  message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.execution_optimization_profiles (
  id uuid primary key default gen_random_uuid(),
  chain text not null,
  contract_key text not null,
  contract_address text,
  contract_type text,
  best_rpc text,
  best_function_path text,
  success_count integer default 0,
  failure_count integer default 0,
  success_rate numeric default 0,
  avg_latency_ms numeric,
  avg_confirmation_ms numeric,
  min_gas numeric,
  max_gas numeric,
  avg_gas numeric,
  retry_profile jsonb default '{}'::jsonb,
  successful_pattern jsonb default '{}'::jsonb,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(chain, contract_key)
);

create index if not exists alpha_vault_wallets_user_idx on public.alpha_vault_wallets(user_id);
create index if not exists mint_intents_user_idx on public.mint_intents(user_id, created_at desc);
create index if not exists mint_attempts_intent_idx on public.mint_attempts(intent_id);
create index if not exists mint_execution_events_intent_idx on public.mint_execution_events(intent_id, created_at);
create index if not exists execution_optimization_profiles_chain_idx on public.execution_optimization_profiles(chain, updated_at desc);

alter table public.alpha_vault_wallets enable row level security;
alter table public.mint_intents enable row level security;
alter table public.mint_attempts enable row level security;
alter table public.mint_execution_events enable row level security;
alter table public.execution_optimization_profiles enable row level security;

drop policy if exists "alpha vault own rows" on public.alpha_vault_wallets;
create policy "alpha vault own rows"
on public.alpha_vault_wallets
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "mint intents own rows" on public.mint_intents;
create policy "mint intents own rows"
on public.mint_intents
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "mint attempts own rows" on public.mint_attempts;
create policy "mint attempts own rows"
on public.mint_attempts
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "mint events own rows" on public.mint_execution_events;
create policy "mint events own rows"
on public.mint_execution_events
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
