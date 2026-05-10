-- Alpha Hub security hardening for Supabase.
-- Run this in Supabase SQL Editor after backing up the current schema.

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists public.subscriptions
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table if exists public.whale_activity
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

create unique index if not exists whale_activity_user_tx_hash_key
on public.whale_activity(user_id, tx_hash);

create index if not exists wl_projects_user_id_idx on public.wl_projects(user_id);
create index if not exists whale_watchlist_user_id_idx on public.whale_watchlist(user_id);
create index if not exists whale_activity_user_id_idx on public.whale_activity(user_id);
create index if not exists notifications_user_id_idx on public.notifications(user_id);
create index if not exists mint_log_user_id_idx on public.mint_log(user_id);
create index if not exists telegram_link_tokens_user_id_idx on public.telegram_link_tokens(user_id);
create index if not exists minting_wallets_user_id_idx on public.minting_wallets(user_id);
create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);
create index if not exists subscriptions_wallet_address_idx on public.subscriptions(lower(wallet_address));
create index if not exists audit_logs_user_id_idx on public.audit_logs(user_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

create or replace function public.current_auth_wallets()
returns text[]
language sql
stable
as $$
  select array_remove(array[
    lower(auth.jwt() #>> '{user_metadata,wallet_address}'),
    lower(auth.jwt() #>> '{user_metadata,walletAddress}'),
    lower(auth.jwt() #>> '{user_metadata,address}'),
    lower(auth.jwt() #>> '{user_metadata,sub}')
  ], null);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins
    where user_id = auth.uid()
  );
$$;

alter table if exists public.admins enable row level security;
alter table if exists public.profiles enable row level security;
alter table if exists public.wl_projects enable row level security;
alter table if exists public.whale_watchlist enable row level security;
alter table if exists public.whale_activity enable row level security;
alter table if exists public.notifications enable row level security;
alter table if exists public.mint_log enable row level security;
alter table if exists public.telegram_link_tokens enable row level security;
alter table if exists public.minting_wallets enable row level security;
alter table if exists public.subscriptions enable row level security;
alter table if exists public.tracked_wallets enable row level security;
alter table if exists public.whale_alerts enable row level security;
alter table if exists public.audit_logs enable row level security;

drop policy if exists "admins can read admins" on public.admins;
create policy "admins can read admins"
on public.admins for select
to authenticated
using (public.is_admin());

drop policy if exists "admins read audit logs" on public.audit_logs;
create policy "admins read audit logs"
on public.audit_logs for select
to authenticated
using (public.is_admin());

drop policy if exists "users read own audit logs" on public.audit_logs;
create policy "users read own audit logs"
on public.audit_logs for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "users manage own wl projects" on public.wl_projects;
create policy "users manage own wl projects"
on public.wl_projects for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own watchlist" on public.whale_watchlist;
create policy "users manage own watchlist"
on public.whale_watchlist for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own whale activity" on public.whale_activity;
create policy "users manage own whale activity"
on public.whale_activity for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own notifications" on public.notifications;
create policy "users manage own notifications"
on public.notifications for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own mint logs" on public.mint_log;
create policy "users manage own mint logs"
on public.mint_log for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own telegram link tokens" on public.telegram_link_tokens;
create policy "users manage own telegram link tokens"
on public.telegram_link_tokens for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own minting wallets" on public.minting_wallets;
create policy "users manage own minting wallets"
on public.minting_wallets for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users read own active subscriptions" on public.subscriptions;
create policy "users read own active subscriptions"
on public.subscriptions for select
to authenticated
using (
  public.is_admin()
  or user_id = auth.uid()
  or lower(wallet_address) = any(public.current_auth_wallets())
);

drop policy if exists "admins manage subscriptions" on public.subscriptions;
create policy "admins manage subscriptions"
on public.subscriptions for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

do $$
begin
  if to_regclass('public.tracked_wallets') is not null then
    execute 'drop policy if exists "users manage own tracked wallets" on public.tracked_wallets';
    execute 'create policy "users manage own tracked wallets"
      on public.tracked_wallets for all
      to authenticated
      using (user_id = auth.uid() or public.is_admin())
      with check (user_id = auth.uid() or public.is_admin())';
  end if;

  if to_regclass('public.whale_alerts') is not null then
    execute 'drop policy if exists "users manage own whale alerts" on public.whale_alerts';
    execute 'create policy "users manage own whale alerts"
      on public.whale_alerts for all
      to authenticated
      using (user_id = auth.uid() or public.is_admin())
      with check (user_id = auth.uid() or public.is_admin())';
  end if;
end $$;
