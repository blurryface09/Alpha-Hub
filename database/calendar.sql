-- Alpha Hub Calendar schema
-- Run in Supabase SQL editor before relying on real calendar submissions.

create table if not exists public.calendar_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text,
  image_url text,
  description text,
  chain text,
  chain_id integer,
  contract_address text,
  mint_url text,
  website_url text,
  x_url text,
  discord_url text,
  mint_date timestamptz,
  mint_date_source text,
  mint_date_confidence text,
  mint_time_confirmed boolean default false,
  mint_price text,
  mint_type text default 'unknown',
  status text default 'pending_review',
  source text,
  source_url text,
  source_confidence text,
  risk_score integer,
  hype_score integer,
  whale_interest_score integer,
  hidden_gem_score integer,
  holder_count integer,
  mint_count integer,
  tracked_wallet_count integer,
  quality_score integer default 0,
  rating_avg numeric default 0,
  rating_count integer default 0,
  share_code text unique,
  share_slug text unique,
  submitted_by_user_id uuid,
  submitted_by_wallet text,
  submitter_role text,
  community_name text,
  community_x_handle text,
  submitted_by_label text,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  last_synced_at timestamptz,
  created_by uuid,
  created_by_wallet text,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.calendar_projects
  add column if not exists quality_score integer default 0,
  add column if not exists rating_avg numeric default 0,
  add column if not exists rating_count integer default 0,
  add column if not exists share_code text,
  add column if not exists share_slug text,
  add column if not exists submitted_by_user_id uuid,
  add column if not exists submitted_by_wallet text,
  add column if not exists submitter_role text,
  add column if not exists community_name text,
  add column if not exists community_x_handle text,
  add column if not exists submitted_by_label text;

create unique index if not exists calendar_projects_share_code_uidx
on public.calendar_projects(share_code)
where share_code is not null;

create unique index if not exists calendar_projects_share_slug_uidx
on public.calendar_projects(share_slug)
where share_slug is not null;

update public.calendar_projects
set
  share_code = coalesce(share_code, 'AH-' || upper(substr(regexp_replace(coalesce(slug, name, id::text), '[^a-zA-Z0-9]', '', 'g'), 1, 6)) || '-' || upper(substr(id::text, 1, 4))),
  share_slug = coalesce(share_slug, lower(regexp_replace(coalesce(slug, name, id::text), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(id::text, 1, 4)),
  quality_score = coalesce(quality_score, 0)
where share_code is null or share_slug is null;

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

create table if not exists public.calendar_project_ratings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.calendar_projects(id) on delete cascade,
  user_id uuid,
  wallet_address text,
  rating integer not null check (rating between 1 and 5),
  review text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(project_id, user_id),
  unique(project_id, wallet_address)
);

alter table public.calendar_projects enable row level security;
alter table public.calendar_project_signals enable row level security;
alter table public.calendar_sync_runs enable row level security;
alter table public.calendar_project_ratings enable row level security;

drop policy if exists "calendar approved readable" on public.calendar_projects;
create policy "calendar approved readable"
on public.calendar_projects
for select
using (
  status in ('approved', 'live', 'ended')
  or public.is_admin()
  or auth.uid() = created_by
);

drop policy if exists "calendar submissions authenticated" on public.calendar_projects;
create policy "calendar submissions authenticated"
on public.calendar_projects
for insert
to authenticated
with check (
  auth.uid() = created_by
  and status = 'pending_review'
  and source = 'community'
);

drop policy if exists "calendar admins manage projects" on public.calendar_projects;
create policy "calendar admins manage projects"
on public.calendar_projects
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "calendar approved signals readable" on public.calendar_project_signals;
create policy "calendar approved signals readable"
on public.calendar_project_signals
for select
using (
  exists (
    select 1
    from public.calendar_projects cp
    where cp.id = calendar_project_signals.project_id
      and (
        cp.status in ('approved', 'live', 'ended')
        or public.is_admin()
        or cp.created_by = auth.uid()
      )
  )
);

drop policy if exists "calendar admins manage signals" on public.calendar_project_signals;
create policy "calendar admins manage signals"
on public.calendar_project_signals
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "calendar sync readable" on public.calendar_sync_runs;
create policy "calendar sync readable"
on public.calendar_sync_runs
for select
using (true);

drop policy if exists "calendar admins manage sync" on public.calendar_sync_runs;
create policy "calendar admins manage sync"
on public.calendar_sync_runs
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "calendar ratings readable" on public.calendar_project_ratings;
create policy "calendar ratings readable"
on public.calendar_project_ratings
for select
using (
  exists (
    select 1
    from public.calendar_projects cp
    where cp.id = calendar_project_ratings.project_id
      and cp.status in ('approved', 'live', 'ended')
  )
  or public.is_admin()
  or auth.uid() = user_id
);

drop policy if exists "calendar ratings authenticated upsert" on public.calendar_project_ratings;
create policy "calendar ratings authenticated upsert"
on public.calendar_project_ratings
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "calendar ratings owner update" on public.calendar_project_ratings;
create policy "calendar ratings owner update"
on public.calendar_project_ratings
for update
using (auth.uid() = user_id or public.is_admin())
with check (auth.uid() = user_id or public.is_admin());

create index if not exists calendar_projects_status_idx on public.calendar_projects(status);
create index if not exists calendar_projects_chain_idx on public.calendar_projects(chain);
create index if not exists calendar_projects_mint_date_idx on public.calendar_projects(mint_date);
create index if not exists calendar_projects_scores_idx on public.calendar_projects(hype_score, hidden_gem_score, whale_interest_score);
create index if not exists calendar_projects_quality_idx on public.calendar_projects(quality_score);
create index if not exists calendar_project_signals_project_idx on public.calendar_project_signals(project_id);
create index if not exists calendar_sync_runs_source_idx on public.calendar_sync_runs(source, created_at desc);
create index if not exists calendar_project_ratings_project_idx on public.calendar_project_ratings(project_id);

alter table if exists public.wl_projects
  add column if not exists calendar_project_id uuid references public.calendar_projects(id) on delete set null;
alter table if exists public.wl_projects
  add column if not exists share_code text;

create index if not exists wl_projects_calendar_project_id_idx on public.wl_projects(calendar_project_id);
