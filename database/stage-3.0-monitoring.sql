-- Stage 3.0 — Monitoring + Alert Engine
-- Run this against your Supabase project.

-- ── monitor_state ─────────────────────────────────────────────────────────────
-- Stores the last-seen values for each watched entity (project or wallet).
-- Used by monitor-poll to detect changes since last check.

create table if not exists public.monitor_state (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  entity_type     text not null,  -- 'project' | 'wallet'
  entity_id       text not null,  -- calendar project uuid or wallet address
  last_status     text,
  last_mint_date  timestamptz,
  last_price      text,
  last_supply     text,
  last_contract   text,
  last_tx_hash    text,
  last_checked_at timestamptz,
  metadata        jsonb default '{}',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (user_id, entity_type, entity_id)
);

create index if not exists monitor_state_user_idx
  on public.monitor_state (user_id);

create index if not exists monitor_state_entity_idx
  on public.monitor_state (entity_type, entity_id);

-- Auto-update updated_at
create or replace function public.touch_monitor_state()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists monitor_state_touch on public.monitor_state;
create trigger monitor_state_touch
  before update on public.monitor_state
  for each row execute function public.touch_monitor_state();

-- RLS
alter table public.monitor_state enable row level security;

drop policy if exists "monitor_state own" on public.monitor_state;
create policy "monitor_state own"
  on public.monitor_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Service role bypass (for worker and cron jobs)
drop policy if exists "monitor_state service" on public.monitor_state;
create policy "monitor_state service"
  on public.monitor_state
  for all
  to service_role
  using (true)
  with check (true);

-- ── notifications — add severity index ────────────────────────────────────────
-- severity and dedup_key are stored in the existing data jsonb column.
-- This GIN index speeds up the dedup query: data->>'dedup_key' = ?

create index if not exists notifications_dedup_key_idx
  on public.notifications using gin (data);

-- ── calendar_project_watchers — no schema changes needed ─────────────────────
-- Existing table (project_id, user_id) is sufficient for monitoring.
-- Follow = row exists, Unfollow = row deleted.
