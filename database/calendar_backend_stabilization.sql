-- Alpha Hub Calendar backend stabilization
-- Purpose: make Calendar ratings, saves, watch/tracking, share codes, and MintGuard imports consistent.
-- Safe to run multiple times in Supabase SQL editor.

create extension if not exists pgcrypto;

create or replace function public.alpha_hub_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'role') = 'service_role', false)
    or coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
    or coalesce((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin', false)
    or coalesce(lower(auth.jwt() -> 'user_metadata' ->> 'wallet_address') = lower(current_setting('app.admin_wallet', true)), false)
$$;

create table if not exists public.calendar_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text,
  image_url text,
  description text,
  chain text default 'eth',
  chain_id integer default 1,
  contract_address text,
  mint_url text,
  website_url text,
  x_url text,
  discord_url text,
  mint_date timestamptz,
  mint_date_source text,
  mint_date_confidence text default 'low',
  mint_time_confirmed boolean default false,
  mint_price text,
  mint_type text default 'unknown',
  status text default 'pending_review',
  source text default 'community',
  source_url text,
  source_confidence text default 'low',
  risk_score integer default 50,
  hype_score integer default 0,
  whale_interest_score integer default 0,
  hidden_gem_score integer default 0,
  holder_count integer,
  mint_count integer default 0,
  tracked_wallet_count integer default 0,
  quality_score integer default 0,
  rating_avg numeric default 0,
  rating_count integer default 0,
  share_code text,
  share_slug text,
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
  add column if not exists slug text,
  add column if not exists image_url text,
  add column if not exists description text,
  add column if not exists chain text default 'eth',
  add column if not exists chain_id integer default 1,
  add column if not exists contract_address text,
  add column if not exists mint_url text,
  add column if not exists website_url text,
  add column if not exists x_url text,
  add column if not exists discord_url text,
  add column if not exists mint_date timestamptz,
  add column if not exists mint_date_source text,
  add column if not exists mint_date_confidence text default 'low',
  add column if not exists mint_time_confirmed boolean default false,
  add column if not exists mint_price text,
  add column if not exists mint_type text default 'unknown',
  add column if not exists status text default 'pending_review',
  add column if not exists source text default 'community',
  add column if not exists source_url text,
  add column if not exists source_confidence text default 'low',
  add column if not exists risk_score integer default 50,
  add column if not exists hype_score integer default 0,
  add column if not exists whale_interest_score integer default 0,
  add column if not exists hidden_gem_score integer default 0,
  add column if not exists holder_count integer,
  add column if not exists mint_count integer default 0,
  add column if not exists tracked_wallet_count integer default 0,
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
  add column if not exists submitted_by_label text,
  add column if not exists first_seen_at timestamptz default now(),
  add column if not exists last_seen_at timestamptz default now(),
  add column if not exists last_synced_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists created_by_wallet text,
  add column if not exists approved_by uuid,
  add column if not exists approved_at timestamptz,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.calendar_projects
  drop constraint if exists calendar_projects_status_check;
alter table public.calendar_projects
  add constraint calendar_projects_status_check
  check (status in ('pending_review', 'pending', 'approved', 'live', 'ended', 'rejected', 'hidden'));

alter table public.calendar_projects
  drop constraint if exists calendar_projects_rating_count_check;
alter table public.calendar_projects
  add constraint calendar_projects_rating_count_check check (rating_count >= 0);

alter table public.calendar_projects
  drop constraint if exists calendar_projects_rating_avg_check;
alter table public.calendar_projects
  add constraint calendar_projects_rating_avg_check check (rating_avg >= 0 and rating_avg <= 5);

create or replace function public.alpha_hub_slug(value text)
returns text
language sql
immutable
as $$
  select trim(both '-' from lower(regexp_replace(coalesce(value, 'alpha'), '[^a-zA-Z0-9]+', '-', 'g')))
$$;

create or replace function public.alpha_hub_make_share_code(project_name text, project_id uuid, chain_name text)
returns text
language plpgsql
stable
as $$
declare
  prefix text;
  body text;
begin
  prefix := case
    when lower(coalesce(chain_name, '')) like '%base%' then 'BASE'
    else 'AH'
  end;
  body := upper(substr(regexp_replace(coalesce(project_name, ''), '[^a-zA-Z0-9]', '', 'g'), 1, 8));
  if length(body) < 4 then
    body := upper(substr(replace(project_id::text, '-', ''), 1, 5));
  end if;
  return prefix || '-' || body;
end;
$$;

create or replace function public.alpha_hub_calendar_defaults()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.slug is null or new.slug = '' then
    new.slug := public.alpha_hub_slug(new.name);
  end if;
  if new.share_code is null or new.share_code = '' then
    new.share_code := public.alpha_hub_make_share_code(new.name, new.id, new.chain);
  end if;
  if new.share_slug is null or new.share_slug = '' then
    new.share_slug := public.alpha_hub_slug(new.name) || '-' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  new.status := case when new.status = 'pending' then 'pending_review' else coalesce(new.status, 'pending_review') end;
  new.quality_score := greatest(0, least(100, coalesce(new.quality_score, 0)));
  return new;
end;
$$;

drop trigger if exists calendar_projects_defaults_trg on public.calendar_projects;
create trigger calendar_projects_defaults_trg
before insert or update on public.calendar_projects
for each row execute function public.alpha_hub_calendar_defaults();

create table if not exists public.calendar_project_ratings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.calendar_projects(id) on delete cascade,
  user_id uuid not null,
  wallet_address text,
  rating integer not null check (rating between 1 and 5),
  review text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(project_id, user_id)
);

alter table public.calendar_project_ratings
  add column if not exists wallet_address text,
  add column if not exists review text,
  add column if not exists updated_at timestamptz default now();

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

create or replace function public.alpha_hub_refresh_calendar_rating(project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.calendar_projects
  set
    rating_avg = coalesce((select round(avg(rating)::numeric, 2) from public.calendar_project_ratings where project_id = project), 0),
    rating_count = coalesce((select count(*) from public.calendar_project_ratings where project_id = project), 0),
    updated_at = now()
  where id = project;
end;
$$;

create or replace function public.alpha_hub_rating_aggregate_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.alpha_hub_refresh_calendar_rating(old.project_id);
    return old;
  end if;
  perform public.alpha_hub_refresh_calendar_rating(new.project_id);
  return new;
end;
$$;

drop trigger if exists calendar_rating_after_insert_update on public.calendar_project_ratings;
create trigger calendar_rating_after_insert_update
after insert or update or delete on public.calendar_project_ratings
for each row execute function public.alpha_hub_rating_aggregate_trg();

with duplicate_codes as (
  select id,
         row_number() over (partition by share_code order by created_at, id) as rn
  from public.calendar_projects
  where share_code is not null
),
duplicate_slugs as (
  select id,
         row_number() over (partition by share_slug order by created_at, id) as rn
  from public.calendar_projects
  where share_slug is not null
)
update public.calendar_projects cp
set
  share_code = case when dc.rn > 1 then cp.share_code || '-' || upper(substr(replace(cp.id::text, '-', ''), 1, 4)) else cp.share_code end,
  share_slug = case when ds.rn > 1 then cp.share_slug || '-' || lower(substr(replace(cp.id::text, '-', ''), 1, 4)) else cp.share_slug end
from duplicate_codes dc
left join duplicate_slugs ds on ds.id = dc.id
where cp.id = dc.id
  and (dc.rn > 1 or coalesce(ds.rn, 1) > 1);

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

alter table if exists public.wl_projects
  add column if not exists calendar_project_id uuid references public.calendar_projects(id) on delete set null,
  add column if not exists share_code text,
  add column if not exists image_url text,
  add column if not exists mint_time_source text,
  add column if not exists mint_time_confidence text,
  add column if not exists mint_time_confirmed boolean default false,
  add column if not exists mint_time_confirmed_at timestamptz,
  add column if not exists execution_status text,
  add column if not exists notes text,
  add column if not exists automint_enabled boolean default false,
  add column if not exists max_mint_price numeric,
  add column if not exists max_gas_fee numeric,
  add column if not exists max_total_spend numeric;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.wl_projects'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike any (array['%source_type%', '%wl_type%', '%status%'])
  loop
    execute format('alter table public.wl_projects drop constraint if exists %I', constraint_name);
  end loop;
exception when undefined_table then
  null;
end $$;

alter table if exists public.wl_projects
  add constraint wl_projects_source_type_check
  check (source_type is null or source_type in ('website', 'twitter', 'opensea', 'calendar', 'contract', 'whale_copy', 'alchemy', 'zora', 'community', 'admin'));

alter table if exists public.wl_projects
  add constraint wl_projects_wl_type_check
  check (wl_type is null or wl_type in ('UNKNOWN', 'WL', 'PUBLIC', 'FREE', 'PAID', 'FCFS', 'ALLOWLIST'));

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
  or public.alpha_hub_is_admin()
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

drop policy if exists "calendar admin manage" on public.calendar_projects;
create policy "calendar admin manage"
on public.calendar_projects
for all
using (public.alpha_hub_is_admin())
with check (public.alpha_hub_is_admin());

drop policy if exists "calendar ratings readable" on public.calendar_project_ratings;
create policy "calendar ratings readable"
on public.calendar_project_ratings
for select
using (
  auth.uid() = user_id
  or public.alpha_hub_is_admin()
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
using (auth.uid() = user_id or public.alpha_hub_is_admin())
with check (auth.uid() = user_id or public.alpha_hub_is_admin());

drop policy if exists "calendar watchers own" on public.calendar_project_watchers;
create policy "calendar watchers own"
on public.calendar_project_watchers
for all
using (auth.uid() = user_id or public.alpha_hub_is_admin())
with check (auth.uid() = user_id or public.alpha_hub_is_admin());

drop policy if exists "calendar saves own" on public.calendar_saved_projects;
create policy "calendar saves own"
on public.calendar_saved_projects
for all
using (auth.uid() = user_id or public.alpha_hub_is_admin())
with check (auth.uid() = user_id or public.alpha_hub_is_admin());

drop policy if exists "calendar signals readable" on public.calendar_project_signals;
create policy "calendar signals readable"
on public.calendar_project_signals
for select
using (
  public.alpha_hub_is_admin()
  or exists (
    select 1 from public.calendar_projects cp
    where cp.id = calendar_project_signals.project_id
      and cp.status in ('approved', 'live', 'ended')
  )
);

drop policy if exists "calendar signals admin" on public.calendar_project_signals;
create policy "calendar signals admin"
on public.calendar_project_signals
for all
using (public.alpha_hub_is_admin())
with check (public.alpha_hub_is_admin());

drop policy if exists "calendar sync readable" on public.calendar_sync_runs;
create policy "calendar sync readable"
on public.calendar_sync_runs
for select
using (true);

drop policy if exists "calendar sync admin" on public.calendar_sync_runs;
create policy "calendar sync admin"
on public.calendar_sync_runs
for all
using (public.alpha_hub_is_admin())
with check (public.alpha_hub_is_admin());

update public.calendar_projects
set
  status = case when status = 'pending' then 'pending_review' else status end,
  share_code = coalesce(share_code, public.alpha_hub_make_share_code(name, id, chain)),
  share_slug = coalesce(share_slug, public.alpha_hub_slug(name) || '-' || substr(replace(id::text, '-', ''), 1, 6)),
  rating_avg = coalesce(rating_avg, 0),
  rating_count = coalesce(rating_count, 0),
  quality_score = coalesce(quality_score, 0),
  updated_at = now();
