create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  wallet_address text not null,
  plan text not null,
  billing_cycle text not null default 'monthly',
  tx_hash text unique not null,
  chain_id integer not null,
  amount_eth numeric not null,
  amount_usd numeric not null,
  token text not null default 'ETH',
  receiver_address text not null,
  status text not null default 'pending_verification',
  created_at timestamptz default now(),
  verified_at timestamptz
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  wallet_address text not null unique,
  plan text not null default 'free',
  billing_cycle text not null default 'monthly',
  status text not null default 'free',
  tx_hash text,
  starts_at timestamptz,
  started_at timestamptz,
  expires_at timestamptz,
  verified boolean default false,
  amount_eth numeric default 0,
  amount_usd numeric default 0,
  chain_id integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table payments enable row level security;
alter table subscriptions enable row level security;

drop policy if exists "users can read own payments" on payments;
create policy "users can read own payments"
on payments
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "users can insert own pending payments" on payments;
create policy "users can insert own pending payments"
on payments
for insert
to authenticated
with check (
  auth.uid() = user_id
  and status = 'pending_verification'
);

drop policy if exists "users can read own subscriptions" on subscriptions;
create policy "users can read own subscriptions"
on subscriptions
for select
to authenticated
using (auth.uid() = user_id);
