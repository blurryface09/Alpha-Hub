-- Alpha Hub Calendar backend stabilization, no-functions version.
-- Use this if Supabase SQL Editor injects RLS comments into function blocks.
-- Paste and run the whole file. It contains no dollar-quoted function bodies.

create extension if not exists pgcrypto;

create table if not exists public.calendar_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

alter table public.calendar_projects add column if not exists slug text;
alter table public.calendar_projects add column if not exists image_url text;
alter table public.calendar_projects add column if not exists description text;
alter table public.calendar_projects add column if not exists chain text default 'eth';
alter table public.calendar_projects add column if not exists chain_id integer default 1;
alter table public.calendar_projects add column if not exists contract_address text;
alter table public.calendar_projects add column if not exists mint_url text;
alter table public.calendar_projects add column if not exists website_url text;
alter table public.calendar_projects add column if not exists x_url text;
alter table public.calendar_projects add column if not exists discord_url text;
alter table public.calendar_projects add column if not exists mint_date timestamptz;
alter table public.calendar_projects add column if not exists mint_date_source text;
alter table public.calendar_projects add column if not exists mint_date_confidence text default 'low';
alter table public.calendar_projects add column if not exists mint_time_confirmed boolean default false;
alter table public.calendar_projects add column if not exists mint_price text;
alter table public.calendar_projects add column if not exists mint_type text default 'unknown';
alter table public.calendar_projects add column if not exists status text default 'pending_review';
alter table public.calendar_projects add column if not exists source text default 'community';
alter table public.calendar_projects add column if not exists source_url text;
alter table public.calendar_projects add column if not exists source_confidence text default 'low';
alter table public.calendar_projects add column if not exists risk_score integer default 50;
alter table public.calendar_projects add column if not exists hype_score integer default 0;
alter table public.calendar_projects add column if not exists whale_interest_score integer default 0;
alter table public.calendar_projects add column if not exists hidden_gem_score integer default 0;
alter table public.calendar_projects add column if not exists holder_count integer;
alter table public.calendar_projects add column if not exists mint_count integer default 0;
alter table public.calendar_projects add column if not exists tracked_wallet_count integer default 0;
alter table public.calendar_projects add column if not exists quality_score integer default 0;
alter table public.calendar_projects add column if not exists rating_avg numeric default 0;
alter table public.calendar_projects add column if not exists rating_count integer default 0;
alter table public.calendar_projects add column if not exists share_code text;
alter table public.calendar_projects add column if not exists share_slug text;
alter table public.calendar_projects add column if not exists submitted_by_user_id uuid;
alter table public.calendar_projects add column if not exists submitted_by_wallet text;
alter table public.calendar_projects add column if not exists submitter_role text;
alter table public.calendar_projects add column if not exists community_name text;
alter table public.calendar_projects add column if not exists community_x_handle text;
alter table public.calendar_projects add column if not exists submitted_by_label text;
alter table public.calendar_projects add column if not exists first_seen_at timestamptz default now();
alter table public.calendar_projects add column if not exists last_seen_at timestamptz default now();
alter table public.calendar_projects add column if not exists last_synced_at timestamptz;
alter table public.calendar_projects add column if not exists created_by uuid;
alter table public.calendar_projects add column if not exists created_by_wallet text;
alter table public.calendar_projects add column if not exists approved_by uuid;
alter table public.calendar_projects add column if not exists approved_at timestamptz;
alter table public.calendar_projects add column if not exists updated_at timestamptz default now();

alter table public.calendar_projects drop constraint if exists calendar_projects_status_check;
alter table public.calendar_projects
  add constraint calendar_projects_status_check
  check (status in ('pending_review', 'pending', 'approved', 'live', 'ended', 'rejected', 'hidden'));

alter table public.calendar_projects drop constraint if exists calendar_projects_rating_count_check;
alter table public.calendar_projects
  add constraint calendar_projects_rating_count_check check (rating_count >= 0);

alter table public.calendar_projects drop constraint if exists calendar_projects_rating_avg_check;
alter table public.calendar_projects
  add constraint calendar_projects_rating_avg_check check (rating_avg >= 0 and rating_avg <= 5);

create table if not exists public.calendar_project_ratings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.calendar_projects(id) on delete cascade,
  user_id uuid not null,
  rating integer not null check (rating between 1 and 5),
  created_at timestamptz default now(),
  unique(project_id, user_id)
);

alter table public.calendar_project_ratings add column if not exists wallet_address text;
alter table public.calendar_project_ratings add column if not exists review text;
alter table public.calendar_project_ratings add column if not exists updated_at timestamptz default now();

create table if not exists public.calendar_project_watchers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.calendar_projects(id) on delete cascade,
  user_id uuid not null,
  wallet_address text,
  created_at timestamptz default now(),
  unique(project_id, user_id)
);

create table if not exists public.calendar_saved_projects (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.calendar_projects(id) on delete cascade,
  user_id uuid not null,
  wallet_address text,
  created_at timestamptz default now(),
  unique(project_id, user_id)
);

create table if not exists public.calendar_project_signals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.calendar_projects(id) on delete cascade,
  signal_type text,
  signal_value jsonb,
  score integer,
  source text,
  created_at timestamptz default now()
);

create table if not exists public.calendar_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null default 'healthy',
  imported_count integer default 0,
  updated_count integer default 0,
  error_count integer default 0,
  errors jsonb default '[]'::jsonb,
  started_at timestamptz default now(),
  finished_at timestamptz,
  created_at timestamptz default now()
);

update public.calendar_projects
set
  status = case when status = 'pending' then 'pending_review' else coalesce(status, 'pending_review') end,
  share_code = coalesce(
    share_code,
    case
      when lower(coalesce(chain, '')) like '%base%' then 'BASE-' || upper(substr(replace(id::text, '-', ''), 1, 6))
      else 'AH-' || upper(substr(replace(id::text, '-', ''), 1, 6))
    end
  ),
  share_slug = coalesce(
    share_slug,
    lower(regexp_replace(coalesce(name, id::text), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(replace(id::text, '-', ''), 1, 6)
  ),
  rating_avg = coalesce(rating_avg, 0),
  rating_count = coalesce(rating_count, 0),
  quality_score = coalesce(quality_score, 0),
  updated_at = now();

create unique index if not exists calendar_projects_share_code_uidx
on public.calendar_projects(share_code)
where share_code is not null;

create unique index if not exists calendar_projects_share_slug_uidx
on public.calendar_projects(share_slug)
where share_slug is not null;

create index if not exists calendar_projects_status_idx on public.calendar_projects(status);
create index if not exists calendar_projects_chain_idx on public.calendar_projects(chain);
create index if not exists calendar_projects_mint_date_idx on public.calendar_projects(mint_date);
create index if not exists calendar_projects_quality_idx on public.calendar_projects(quality_score);
create index if not exists calendar_project_ratings_project_idx on public.calendar_project_ratings(project_id);
create index if not exists calendar_project_watchers_project_idx on public.calendar_project_watchers(project_id);
create index if not exists calendar_saved_projects_project_idx on public.calendar_saved_projects(project_id);
create index if not exists calendar_project_signals_project_idx on public.calendar_project_signals(project_id);
create index if not exists calendar_sync_runs_source_idx on public.calendar_sync_runs(source, created_at desc);

alter table if exists public.wl_projects add column if not exists calendar_project_id uuid references public.calendar_projects(id) on delete set null;
alter table if exists public.wl_projects add column if not exists share_code text;
alter table if exists public.wl_projects add column if not exists image_url text;
alter table if exists public.wl_projects add column if not exists mint_time_source text;
alter table if exists public.wl_projects add column if not exists mint_time_confidence text;
alter table if exists public.wl_projects add column if not exists mint_time_confirmed boolean default false;
alter table if exists public.wl_projects add column if not exists mint_time_confirmed_at timestamptz;
alter table if exists public.wl_projects add column if not exists execution_status text;
alter table if exists public.wl_projects add column if not exists notes text;
alter table if exists public.wl_projects add column if not exists automint_enabled boolean default false;
alter table if exists public.wl_projects add column if not exists max_mint_price numeric;
alter table if exists public.wl_projects add column if not exists max_gas_fee numeric;
alter table if exists public.wl_projects add column if not exists max_total_spend numeric;

create index if not exists wl_projects_calendar_project_id_idx on public.wl_projects(calendar_project_id);
create unique index if not exists wl_projects_user_calendar_project_uidx
on public.wl_projects(user_id, calendar_project_id)
where calendar_project_id is not null;

alter table public.calendar_projects enable row level security;
alter table public.calendar_project_ratings enable row level security;
alter table public.calendar_project_watchers enable row level security;
alter table public.calendar_saved_projects enable row level security;
alter table public.calendar_project_signals enable row level security;
alter table public.calendar_sync_runs enable row level security;

drop policy if exists "calendar projects readable" on public.calendar_projects;
create policy "calendar projects readable"
on public.calendar_projects
for select
using (
  status in ('approved', 'live', 'ended')
  or auth.uid() = created_by
);

drop policy if exists "calendar community insert" on public.calendar_projects;
create policy "calendar community insert"
on public.calendar_projects
for insert
to authenticated
with check (
  auth.uid() = created_by
  and source = 'community'
  and status in ('pending_review', 'pending')
);

drop policy if exists "calendar ratings readable" on public.calendar_project_ratings;
create policy "calendar ratings readable"
on public.calendar_project_ratings
for select
using (
  auth.uid() = user_id
  or exists (
    select 1 from public.calendar_projects cp
    where cp.id = calendar_project_ratings.project_id
      and cp.status in ('approved', 'live', 'ended')
  )
);

drop policy if exists "calendar ratings insert own" on public.calendar_project_ratings;
create policy "calendar ratings insert own"
on public.calendar_project_ratings
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "calendar ratings update own" on public.calendar_project_ratings;
create policy "calendar ratings update own"
on public.calendar_project_ratings
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "calendar watchers own" on public.calendar_project_watchers;
create policy "calendar watchers own"
on public.calendar_project_watchers
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "calendar saves own" on public.calendar_saved_projects;
create policy "calendar saves own"
on public.calendar_saved_projects
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "calendar signals readable" on public.calendar_project_signals;
create policy "calendar signals readable"
on public.calendar_project_signals
for select
using (
  exists (
    select 1 from public.calendar_projects cp
    where cp.id = calendar_project_signals.project_id
      and cp.status in ('approved', 'live', 'ended')
  )
);

drop policy if exists "calendar sync readable" on public.calendar_sync_runs;
create policy "calendar sync readable"
on public.calendar_sync_runs
for select
using (true);
