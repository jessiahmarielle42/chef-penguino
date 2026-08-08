-- Wishlist + Emote Series (one combined migration; run once in Supabase SQL Editor)
--
-- Feature 1 (wishlist): private per-user list of unowned emote ids the chef
-- has starred in the shop. Synced for signed-in users; guests stay in
-- localStorage. Only the owner ever reads it, so existing own-row RLS on
-- profiles covers it - no new policies.
--
-- Feature 2 (emote series): ordered list (max 5, enforced client-side and by
-- the CHECK below) of owned emote ids the hero card cycles through on tap.
-- Slot 1 is the equipped/main emote. VISIBLE TO VISITORS via the same profile
-- read path that already exposes equipped_emote, so no new policies here
-- either. NULL means "no series set" -> app falls back to the single
-- equipped emote exactly as today (backward-safe pre/post migration).

alter table public.profiles
  add column if not exists wishlist text[] not null default '{}';

alter table public.profiles
  add column if not exists emote_series text[];

-- Belt-and-braces server-side cap so a buggy client can never store a
-- runaway series. NULL passes (no series set).
do $$ begin
  alter table public.profiles
    add constraint emote_series_max5
    check (emote_series is null or array_length(emote_series, 1) between 1 and 5);
exception when duplicate_object then null; end $$;

-- Verify:
--   select column_name from information_schema.columns
--   where table_name = 'profiles' and column_name in ('wishlist','emote_series');
