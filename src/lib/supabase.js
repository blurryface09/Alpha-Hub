import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { params: { eventsPerSecond: 10 } },
})

// ─── DATABASE SCHEMA (run this in Supabase SQL editor) ───────────
// Copy and run this in your Supabase project → SQL Editor → New Query

export const SCHEMA_SQL = `
-- Enable realtime
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table whale_activity;

-- Users profile (extends Supabase auth)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique,
  wallet_address text,
  avatar_url text,
  created_at timestamp with time zone default timezone('utc', now()),
  updated_at timestamp with time zone default timezone('utc', now())
);

-- WL Projects tracker
create table if not exists wl_projects (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  name text not null,
  image_url text,
  source_url text not null,
  source_type text check (source_type in ('twitter', 'opensea', 'website', 'manual')),
  chain text not null default 'eth',
  contract_address text,
  mint_date timestamp with time zone,
  mint_price text,
  wl_type text check (wl_type in ('GTD', 'FCFS', 'RAFFLE', 'UNKNOWN')) default 'UNKNOWN',
  mint_mode text check (mint_mode in ('confirm', 'auto')) default 'confirm',
  status text check (status in ('upcoming', 'live', 'minted', 'missed', 'cancelled')) default 'upcoming',
  max_mint integer default 1,
  gas_limit integer default 200000,
  notes text,
  created_at timestamp with time zone default timezone('utc', now())
);

-- Whale wallet watchlist
create table if not exists whale_watchlist (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  wallet_address text not null,
  label text,
  chain text not null default 'eth',
  last_checked timestamp with time zone,
  last_tx_hash text,
  is_active boolean default true,
  created_at timestamp with time zone default timezone('utc', now()),
  unique(user_id, wallet_address, chain)
);

-- Whale activity feed
create table if not exists whale_activity (
  id uuid default gen_random_uuid() primary key,
  wallet_address text not null,
  wallet_label text,
  chain text not null,
  tx_hash text not null unique,
  action_type text,
  contract_address text,
  contract_name text,
  value_eth numeric,
  value_usd numeric,
  method_id text,
  method_name text,
  is_mint boolean default false,
  block_number bigint,
  timestamp timestamp with time zone,
  raw_data jsonb,
  created_at timestamp with time zone default timezone('utc', now())
);

-- In-app notifications
create table if not exists notifications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  type text check (type in ('mint_live', 'whale_move', 'whale_mint', 'rug_alert', 'mint_success', 'mint_failed', 'system')),
  title text not null,
  message text not null,
  data jsonb,
  read boolean default false,
  created_at timestamp with time zone default timezone('utc', now())
);

-- Mint execution log
create table if not exists mint_log (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  project_id uuid references wl_projects(id),
  wallet_address text not null,
  chain text not null,
  tx_hash text,
  status text check (status in ('pending', 'success', 'failed', 'cancelled')),
  gas_used text,
  error_message text,
  executed_at timestamp with time zone default timezone('utc', now())
);

-- Row level security
alter table profiles enable row level security;
alter table wl_projects enable row level security;
alter table whale_watchlist enable row level security;
alter table notifications enable row level security;
alter table mint_log enable row level security;

create policy "Users can manage own data" on profiles for all using (auth.uid() = id);
create policy "Users can manage own wl_projects" on wl_projects for all using (auth.uid() = user_id);
create policy "Users can manage own whale_watchlist" on whale_watchlist for all using (auth.uid() = user_id);
create policy "Users can read own notifications" on notifications for all using (auth.uid() = user_id);
create policy "Users can read own mint_log" on mint_log for all using (auth.uid() = user_id);
create policy "Anyone can read whale_activity" on whale_activity for select using (true);
create policy "Service can insert whale_activity" on whale_activity for insert with check (true);
`
