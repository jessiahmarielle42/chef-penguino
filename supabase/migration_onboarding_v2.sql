-- Onboarding v2.5.0.0: unified tour, one purchase RPC.
-- Run this once in the Supabase SQL Editor, AFTER migration_onboarding.sql.
-- Idempotent - safe to run more than once.
--
-- Replaces the old two-step claim_onboarding_coin() (grant the coin) +
-- client-side buyEmote()/equipEmote() (spend it on waving) with ONE
-- SECURITY DEFINER RPC that does the whole "free coin -> buy waving" thing
-- as a single atomic write, called exactly once, on the real "Yes, unlock
-- it" tap in the tour's buy-waving step - see confirmBuyTour()/
-- completeOnboardingPurchase() in app/src/main.js. Nothing is written
-- anywhere before that tap; abandoning the tour before then forfeits and
-- grants nothing.
--
-- claim_onboarding_coin() is left in place (harmless, unused by the client
-- from this version on) rather than dropped, in case anything else still
-- references it; feel free to drop it in a later cleanup pass once this is
-- confirmed live.

create or replace function public.complete_onboarding_purchase()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  me public.profiles%rowtype;
  already_owns boolean;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found then
    raise exception 'No profile';
  end if;

  -- Idempotency guard: this is the ONLY thing that makes the two relative
  -- writes below (coin_adjustment + 1, owned_emotes append) safe to re-run.
  -- Once onboarding_coin_claimed is true, every future call is a pure no-op
  -- - a re-tap, a retried request, a re-run tour after Skip Tutorial - can
  -- never grant a second coin or append 'waving' twice.
  if me.onboarding_coin_claimed then
    return;
  end if;

  already_owns := me.waving_free or ('waving' = any(coalesce(me.owned_emotes, '{}')));

  if already_owns then
    -- Already an owner (grandfathered via waving_free, or bought it before
    -- reaching this step some other way): a paid emote can never be lost or
    -- double-granted, so this is just the claim-flag write - no coin, no
    -- owned_emotes change, no equip (they're already equipped or free to
    -- equip it already).
    update public.profiles
    set onboarding_coin_claimed = true
    where id = auth.uid();
  else
    -- Single UPDATE, one transaction: +1 coin AND +waving in owned_emotes
    -- are applied together, so the derived balance
    --   floor(pizzas/12) - length(owned_emotes) + coin_adjustment
    -- is net-zero before and after - the free coin exists only long enough
    -- to be spent on the same emote it paid for, atomically.
    update public.profiles
    set coin_adjustment = coalesce(coin_adjustment, 0) + 1,
        owned_emotes = array_append(coalesce(owned_emotes, '{}'), 'waving'),
        equipped_emote = 'waving',
        onboarding_coin_claimed = true
    where id = auth.uid();
  end if;
end;
$$;

grant execute on function public.complete_onboarding_purchase() to authenticated;

-- No RLS changes needed: same reasoning as claim_onboarding_coin() before
-- it - coin_adjustment/owned_emotes/equipped_emote stay writable by the
-- owner as they already were (coin-gifting, the normal shop purchase flow),
-- this RPC just bundles three of those writes into one atomic, idempotent
-- call for the tour's specific free-coin-into-waving path.
