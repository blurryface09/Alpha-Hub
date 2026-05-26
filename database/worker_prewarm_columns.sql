-- Worker prewarm handoff columns for mint_intents.
--
-- The prewarmer (worker/lib/prewarmer.js) runs 30s before strike_execute_at and
-- writes the resolved tx params so the executor can skip prepareMintTransaction at T=0.
-- The executor (worker/lib/executor.js) reads these at execution time.
--
-- These are SEPARATE from prepared_to / prepared_data / prepared_value which are
-- written by the API arm phase (auto-mint.js) and never read by the worker.
--
-- Field mapping (prewarmer write → executor read):
--   call_data     ← prepared.data       (encoded calldata; null = no prewarm, re-run prepare)
--   gas_limit     ← prepared.gas        (gas units, e.g. 150000; distinct from max_gas_fee which is ETH)
--   to            ← prepared.to         (tx target: SeaDrop router or NFT contract directly)
--   value         ← prepared.value      (wei string, e.g. '900000000000000' for 0.0009 ETH)
--   function_name ← prepared.functionName (e.g. 'mintPublic'; used for telemetry + fast-path log)
--   gas_strategy  ← intent field        (safe | balanced | aggressive; default 'balanced')

alter table public.mint_intents
  add column if not exists call_data     text,
  add column if not exists gas_limit     bigint,
  add column if not exists "to"          text,
  add column if not exists value         text,
  add column if not exists function_name text,
  add column if not exists gas_strategy  text default 'balanced';

-- Index for fast prewarm lookup (intents approaching their execute window)
create index if not exists mint_intents_prewarm_idx
  on public.mint_intents (strike_execute_at, strike_enabled, status)
  where strike_enabled = true and status = 'armed';
