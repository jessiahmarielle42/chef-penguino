-- Onboarding tutorial + the waving emote becoming a paid unlock.
-- Run this once in the Supabase SQL Editor.
-- Idempotent - safe to run more than once.

-- ---------- 1. tutorial state ----------
-- onboarding_done: the tutorial has been completed (or skipped) at least once.
-- onboarding_coin_claimed: the one free Penguino Coin the tutorial grants has
-- been handed out. Separate from onboarding_done on purpose - replaying the
-- tutorial is fine, granting a second coin is not, so the coin needs its own
-- high-water mark rather than being inferred from "have they seen this".
alter table public.profiles add column if not exists onboarding_done boolean not null default false;
alter table public.profiles add column if not exists onboarding_coin_claimed boolean not null default false;

-- Existing chefs are treated as already onboarded. Both columns default to
-- false, so without this every current user would be auto-started into a
-- tutorial for an app they already know the next time they opened it. They can
-- still replay it from Settings whenever they want.
-- Same cutoff reasoning as waving_free below: run this promptly after deploying.
update public.profiles
set onboarding_done = true
where onboarding_done = false
  and created_at <= now();

-- ---------- 2. grandfathering the waving emote ----------
-- The waving emote used to be free for everyone, hardcoded client-side and
-- deliberately NOT stored in owned_emotes. New signups must now buy it, but
-- existing chefs keep it.
--
-- This is a flag rather than "just insert 'waving' into owned_emotes", because
-- the coin balance is derived:
--     balance = floor(pizzas/12) - length(owned_emotes) + coin_adjustment
-- Adding 'waving' to owned_emotes would lengthen that array by one and so
-- silently deduct a coin from every existing chef. The flag grants the emote
-- without touching the balance maths.
alter table public.profiles add column if not exists waving_free boolean not null default false;

-- Every profile that exists RIGHT NOW keeps waving for free. The column
-- defaults to false, so profiles created after this runs do not.
-- Guarded so re-running can't re-grant it to newer profiles: only rows created
-- at or before this migration's own cutoff are touched. Adjust the timestamp if
-- you run this later than intended.
update public.profiles
set waving_free = true
where waving_free = false
  and created_at <= now();

-- ---------- 3. the tutorial's free coin ----------
-- Granting the coin has to be server-side: coin_adjustment is a plain column a
-- signed-in chef could otherwise update directly, so a client-side "give me a
-- coin" would be trivially repeatable.
--
-- Refuses to grant when the chef has already claimed it, has already earned a
-- coin the honest way (12 pizzas = 1 coin), or has been gifted/adjusted coins.
-- In every one of those cases it still marks the claim as spent, so the client
-- can simply skip the step without a second round trip.
--
-- Returns true only when a coin was actually granted.
create or replace function public.claim_onboarding_coin()
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  me public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found then
    raise exception 'No profile';
  end if;

  if me.onboarding_coin_claimed
     or floor(floor(me.pizzas) / 12) >= 1
     or coalesce(me.coin_adjustment, 0) <> 0
     or 'waving' = any(coalesce(me.owned_emotes, '{}'))
     or me.waving_free
  then
    update public.profiles
    set onboarding_coin_claimed = true
    where id = auth.uid();
    return false;
  end if;

  update public.profiles
  set coin_adjustment = coalesce(coin_adjustment, 0) + 1,
      onboarding_coin_claimed = true
  where id = auth.uid();
  return true;
end;
$$;

grant execute on function public.claim_onboarding_coin() to authenticated;

-- ---------- 4. RLS ----------
-- The existing "users can update their own profile" policy already covers
-- onboarding_done, so nothing is added here. coin_adjustment stays writable by
-- the owner as it was before - the RPC above is about not NEEDING to write it
-- from the client, not about locking it down further, which would break the
-- existing coin-gifting flow.
