-- Backfill missing columns on mint_execution_events.
-- The table was created before the state/message/metadata columns were added
-- to alpha_radar_mint_engine.sql. CREATE TABLE IF NOT EXISTS skipped them.

alter table public.mint_execution_events
  add column if not exists state    text,
  add column if not exists message  text,
  add column if not exists metadata jsonb default '{}'::jsonb;

-- Backfill nulls so existing rows satisfy the not-null expectation of new inserts
update public.mint_execution_events set state = 'unknown' where state is null;
