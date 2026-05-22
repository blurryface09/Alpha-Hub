-- Fix: add project_id column to mint_intents.
-- The CREATE TABLE IF NOT EXISTS in alpha_radar_mint_engine.sql is a no-op when the
-- table already exists, so this column was never added to older deployments.
-- Safe to run multiple times (IF NOT EXISTS).

alter table if exists public.mint_intents
  add column if not exists project_id uuid;
