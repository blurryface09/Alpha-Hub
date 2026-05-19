-- Stage 3.1: Wallet Intelligence
-- Conviction-scored wallet profiles + smart wallet alerts

-- ── wallet_profiles ──────────────────────────────────────────────────────────
-- Cached aggregates per wallet, updated by the cron sweep.
-- address+chain is the PK — wallet profiles are global (not per-user).

create table if not exists public.wallet_profiles (
  address          text        not null,
  chain            text        not null default 'eth',
  ens_name         text,
  label            text,
  total_mints      int         not null default 0,
  unique_contracts int         not null default 0,
  large_mints      int         not null default 0,  -- mints >= 0.5 ETH
  repeat_mints     int         not null default 0,  -- contracts minted >1 time
  conviction_score int         not null default 0,  -- 0-100
  first_seen_at    timestamptz,
  last_active_at   timestamptz,
  updated_at       timestamptz default now(),
  primary key (address, chain)
);

-- Public read, service-role write only
alter table public.wallet_profiles enable row level security;
drop policy if exists "wallet profiles read" on public.wallet_profiles;
create policy "wallet profiles read"
  on public.wallet_profiles for select using (true);

create index if not exists wallet_profiles_conviction_idx
  on public.wallet_profiles(conviction_score desc);
create index if not exists wallet_profiles_chain_idx
  on public.wallet_profiles(chain);
