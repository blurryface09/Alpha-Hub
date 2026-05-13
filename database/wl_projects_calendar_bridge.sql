-- Alpha Hub Calendar -> MintGuard bridge patch.
-- Safe to paste in Supabase SQL editor. No functions/triggers.

alter table if exists public.wl_projects add column if not exists calendar_project_id uuid;
alter table if exists public.wl_projects add column if not exists share_code text;
alter table if exists public.wl_projects add column if not exists image_url text;
alter table if exists public.wl_projects add column if not exists mint_url text;
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

alter table if exists public.wl_projects drop constraint if exists wl_projects_source_type_check;
alter table if exists public.wl_projects drop constraint if exists wl_projects_wl_type_check;

alter table if exists public.wl_projects
  add constraint wl_projects_source_type_check
  check (source_type is null or source_type in ('website', 'url', 'twitter', 'x', 'opensea', 'calendar', 'contract', 'whale_copy', 'alchemy', 'zora', 'community', 'admin'));

alter table if exists public.wl_projects
  add constraint wl_projects_wl_type_check
  check (wl_type is null or wl_type in ('UNKNOWN', 'GTD', 'FCFS', 'PUBLIC', 'RAFFLE', 'FREE', 'PAID', 'ALLOWLIST', 'WL'));

create index if not exists wl_projects_calendar_project_id_idx on public.wl_projects(calendar_project_id);

create unique index if not exists wl_projects_user_calendar_project_uidx
on public.wl_projects(user_id, calendar_project_id)
where calendar_project_id is not null;
