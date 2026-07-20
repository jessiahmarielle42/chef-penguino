-- Chef Penguino: emote shop + Penguino Coin economy
-- Run once in the Supabase SQL Editor after schema.sql.
--
-- The coin economy is fully DERIVED from the existing lifetime `pizzas`
-- count, so nothing can desync:
--   coins earned   = floor(pizzas / 12)
--   coins spent    = number of owned (purchased) emotes
--   coin balance   = coins earned - coins spent
--   pizzas in stash = pizzas mod 12   (shown on the home dashboard)
-- We only persist which emotes the player owns; everything else is computed
-- on the client. 'waving' is free and always owned, so it is NOT stored here.

alter table public.profiles
  add column if not exists owned_emotes text[] not null default '{}';

-- (RLS already lets a user update their own profile row via the existing
--  "users can update their own profile" policy, so no new policy is needed.)
