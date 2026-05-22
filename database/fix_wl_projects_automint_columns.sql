-- Fix: add all columns written by auto-mint worker to wl_projects.
-- These were only in CREATE TABLE statements and never had ALTER TABLE migrations.
-- Safe to run multiple times (IF NOT EXISTS).

alter table if exists public.wl_projects
  add column if not exists simulation_status      text,
  add column if not exists simulation_error       text,
  add column if not exists simulated_at           timestamptz,
  add column if not exists simulation_started_at  timestamptz,
  add column if not exists gas_estimate           text,
  add column if not exists time_to_simulate_ms    integer,
  add column if not exists prepared_to            text,
  add column if not exists prepared_data          text,
  add column if not exists prepared_value         text,
  add column if not exists prepared_chain_id      integer,
  add column if not exists prepared_at            timestamptz,
  add column if not exists time_to_prepare_ms     integer,
  add column if not exists execution_started_at   timestamptz,
  add column if not exists submitted_at           timestamptz,
  add column if not exists time_to_submit_ms      integer,
  add column if not exists confirmed_at           timestamptz,
  add column if not exists execution_reason       text;
