-- Alpha Hub v2: Alpha Radar + Mint Engine + Alpha Vault.
-- Safe to paste in Supabase SQL editor. No triggers/functions.

alter table if exists public.calendar_projects add column if not exists mint_phase text default 'unknown';
alter table if exists public.calendar_projects add column if not exists source_timezone text;
alter table if exists public.calendar_projects add column if not exists recommended_mode text default 'safe';
alter table if exists public.calendar_projects add column if not exists supply text;

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
  status text default 'draft',
  tx_hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.mint_attempts (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.mint_intents(id) on delete cascade,
  user_id uuid not null,
  status text default 'queued',
  tx_hash text,
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.mint_execution_events (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.mint_intents(id) on delete cascade,
  user_id uuid not null,
  state text not null,
  message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists alpha_vault_wallets_user_idx on public.alpha_vault_wallets(user_id);
create index if not exists mint_intents_user_idx on public.mint_intents(user_id, created_at desc);
create index if not exists mint_attempts_intent_idx on public.mint_attempts(intent_id);
create index if not exists mint_execution_events_intent_idx on public.mint_execution_events(intent_id, created_at);

alter table public.alpha_vault_wallets enable row level security;
alter table public.mint_intents enable row level security;
alter table public.mint_attempts enable row level security;
alter table public.mint_execution_events enable row level security;

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
