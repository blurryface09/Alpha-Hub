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
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  created_by uuid,
  created_by_wallet text,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
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

alter table public.calendar_projects enable row level security;
alter table public.calendar_project_signals enable row level security;

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

create index if not exists calendar_projects_status_idx on public.calendar_projects(status);
create index if not exists calendar_projects_chain_idx on public.calendar_projects(chain);
create index if not exists calendar_projects_mint_date_idx on public.calendar_projects(mint_date);
create index if not exists calendar_projects_scores_idx on public.calendar_projects(hype_score, hidden_gem_score, whale_interest_score);
create index if not exists calendar_project_signals_project_idx on public.calendar_project_signals(project_id);

alter table if exists public.wl_projects
  add column if not exists calendar_project_id uuid references public.calendar_projects(id) on delete set null;

create index if not exists wl_projects_calendar_project_id_idx on public.wl_projects(calendar_project_id);
