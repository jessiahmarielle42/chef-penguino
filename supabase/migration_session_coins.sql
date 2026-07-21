-- Adds an optional coins column to sessions so admin coin adjustments can be
-- shown in a user's log with a coin (instead of a pizza). Run once in the
-- Supabase SQL Editor.

alter table public.sessions add column if not exists coins numeric;
