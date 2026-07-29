-- Move every chef who is wearing a picture above their level into the best
-- picture they've actually earned.
--
-- How they got there: the avatar-unlock trigger only validates avatar_url when
-- it CHANGES, so a picture equipped before its unlock_level was set (or before
-- the ladder was renumbered) is never revoked server-side. The picker then
-- compounded it by exempting the equipped picture from its lock check, so an
-- affected chef saw one more unlocked picture than they had earned.
--
-- The client now self-heals on sign in (ensureAvatarWithinLevel), but that only
-- fires when someone next opens the app - this fixes everyone at once.
--
-- Only touches profiles that are actually over-levelled: a custom/legacy
-- avatar_url that isn't in preset_avatars is left alone, and so is anyone whose
-- picture is already within their level.
--
-- Run this once in the Supabase SQL Editor. Idempotent - running it again is a
-- no-op once every profile is within level.

-- A correlated scalar subquery in SET, not UPDATE ... FROM LATERAL: the update
-- target isn't visible to the FROM clause, so a lateral join referencing p
-- fails with 42P10 ("invalid reference to FROM-clause entry for table p").
--
-- The second exists() is load-bearing. Without it, a profile with no picture
-- at or below its level would match the first exists(), the subquery would
-- return no row, and avatar_url would be set to NULL - wiping the picture
-- instead of skipping the profile.
update public.profiles p
set avatar_url = (
  select pa.url
  from public.preset_avatars pa
  where pa.unlock_level <= public.level_for_pizzas(p.pizzas)
  order by pa.unlock_level desc
  limit 1
)
where p.avatar_url is not null
  and exists (
    select 1 from public.preset_avatars cur
    where cur.url = p.avatar_url
      and cur.unlock_level > public.level_for_pizzas(p.pizzas)
  )
  and exists (
    select 1 from public.preset_avatars ok
    where ok.unlock_level <= public.level_for_pizzas(p.pizzas)
  );

-- Check afterwards - should return zero rows:
-- select p.id, p.pizzas, public.level_for_pizzas(p.pizzas) as lvl, pa.unlock_level
-- from public.profiles p
-- join public.preset_avatars pa on pa.url = p.avatar_url
-- where pa.unlock_level > public.level_for_pizzas(p.pizzas);
