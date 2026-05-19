-- Stage 3.1: wl_project_watchers
--
-- calendar_project_watchers.project_id has a FK to calendar_projects(id).
-- wl_projects rows are not in calendar_projects, so inserts from MintGuard
-- cards fail with a FK violation and silently roll back the watch state.
-- This table stores watches for wl_projects specifically.

create table if not exists public.wl_project_watchers (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references public.wl_projects(id) on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  created_at  timestamptz default now(),
  unique(project_id, user_id)
);

alter table public.wl_project_watchers enable row level security;

drop policy if exists "wl watchers own" on public.wl_project_watchers;
create policy "wl watchers own"
  on public.wl_project_watchers
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists wl_project_watchers_user_idx
  on public.wl_project_watchers(user_id);

create index if not exists wl_project_watchers_project_idx
  on public.wl_project_watchers(project_id);
