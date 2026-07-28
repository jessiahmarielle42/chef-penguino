-- Level system: levels are DERIVED from public.profiles.pizzas, never
-- stored as their own source of truth. Adds unlock levels to preset
-- avatars, a "highest level celebration already shown" marker on
-- profiles, the derivation function, and a server-side guard so a locked
-- picture can't be equipped by calling the REST API directly.
-- Run this once in the Supabase SQL Editor.
-- Idempotent - safe to run more than once.

-- ---------- 1. unlock_level on preset_avatars ----------
alter table public.preset_avatars add column if not exists unlock_level int not null default 1;

-- ---------- 2. level_seen on profiles ----------
-- Tracks the highest level the user has already been shown a celebration
-- popup for, so the client can decide whether to pop the "Level up!"
-- animation on load.
alter table public.profiles add column if not exists level_seen int not null default 1;

-- ---------- 3. pizzas -> level derivation ----------
-- The level curve: going from level N to N+1 costs
--   cost(N) = min(12, ceil(N / 2))
-- pizzas. That ramps 1,1,2,2,3,3,...,12,12 as N goes 1,2,3,4,...,23,24, and
-- is flat at 12 forever after (N >= 24).
--
-- Cumulative pizzas needed to REACH level L (i.e. total pizzas baked by the
-- time the player dings level L), for L <= 24, works out to the closed form
--   cum(L) = floor(L^2 / 4)
-- e.g. cum(1)=0, cum(2)=1, cum(3)=2, cum(4)=4, cum(24)=144.
-- Past L = 24 the per-level cost is flat 12, so
--   cum(L) = 144 + 12 * (L - 24)          for L > 24
--
-- The function below is the INVERSE of cum(L): given a pizza total P,
-- what is the highest level L such that cum(L) <= P?
--
-- For the ramping region (P < 144, i.e. L <= 24) the inverse of
-- floor(L^2/4) <= P is the closed form:
--   L = floor(sqrt(4P + 1))
-- This is only exact while the cost is still ramping (up to level 24 /
-- 144 pizzas) - past that the cost is flat 12/level, so the sqrt curve
-- would keep climbing while the real curve goes linear. That's why this
-- function is piecewise: sqrt form below 144 pizzas, linear form at/above
-- it.
--
-- IMPORTANT gotcha found while sanity-checking this by hand: cum(L) is only
-- ever an integer (every per-level cost is a whole number of pizzas), so a
-- level threshold only ever falls on an integer pizza count. But pizzas is
-- numeric/fractional, and plugging a fractional p straight into the
-- continuous sqrt(4p+1) curve OVERSHOOTS just below an integer threshold -
-- e.g. at p = 143.9, floor(sqrt(4*143.9+1)) = floor(sqrt(576.6)) =
-- floor(24.0125) = 24, even though the player hasn't actually reached the
-- 144-pizza threshold for level 24 yet (still level 23). The fix is to
-- floor the pizza count before feeding it into the ramp-region formula -
-- fractional progress within a level never crosses an integer threshold,
-- so only the integer part of p can matter for which level you're at.
--
-- Boundary check (by hand), with the floor(p) fix in place:
--   p = 143.9 -> ramp branch:   floor(sqrt(4*floor(143.9) + 1))
--                = floor(sqrt(4*143 + 1)) = floor(sqrt(573)) = floor(23.94..) = 23 ✓
--   p = 144   -> linear branch: 24 + floor((144 - 144) / 12) = 24 + 0        = 24 ✓
--   p = 156   -> linear branch: 24 + floor((156 - 144) / 12) = 24 + 1        = 25 ✓
-- The two branches agree exactly at the seam (cum(24) = 144), so splitting
-- at p >= 144 is safe: below it the (floored) sqrt curve is exact, at/above
-- it the flat-12-per-level linear form is exact.
create or replace function public.level_for_pizzas(p numeric)
returns int
language sql
immutable
as $$
  select case
    when greatest(p, 0) >= 144 then 24 + floor((greatest(p, 0) - 144) / 12)::int
    else greatest(1, floor(sqrt(4 * floor(greatest(p, 0)) + 1))::int)
  end;
$$;

-- ---------- 4. guard: can't equip a picture above your unlocked level ----------
-- Client-side locking in the UI is not enough - this is the real
-- enforcement against the REST API. Skips validation entirely when
-- avatar_url didn't change, so grandfathered users who already wear a
-- picture that later became locked (unlock_level raised after they set
-- it) are never broken by an unrelated profile update (e.g. changing
-- display_name). The admin is exempt so they can reassign avatars for
-- other users from the Users screen regardless of that user's level.
create or replace function public.enforce_avatar_unlock()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  required_level int;
  avatar_changed boolean;
begin
  -- OLD isn't assigned on INSERT (no prior row exists), so TG_OP must be
  -- checked before touching old.avatar_url or this raises "record \"old\"
  -- is not assigned yet" on every new-user signup.
  if tg_op = 'INSERT' then
    avatar_changed := new.avatar_url is not null;
  else
    avatar_changed := new.avatar_url is distinct from old.avatar_url;
  end if;

  if avatar_changed then
    if new.avatar_url is not null and auth.email() is distinct from 'keefefons@gmail.com' then
      select unlock_level into required_level
      from public.preset_avatars
      where url = new.avatar_url;

      if required_level is not null and required_level > public.level_for_pizzas(new.pizzas) then
        raise exception 'That picture unlocks at level %', required_level;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_profile_avatar_change on public.profiles;
create trigger on_profile_avatar_change
  before insert or update of avatar_url on public.profiles
  for each row execute function public.enforce_avatar_unlock();

-- ---------- 5. RLS check ----------
-- "users can update their own profile" (schema.sql) is a plain
--   using (id = auth.uid())
-- UPDATE policy with no WITH CHECK clause. Postgres reuses USING as the
-- WITH CHECK when one isn't given, so a user updating their own
-- level_seen (or any other column) on their own row is already allowed.
-- Nothing to add here.

-- ============================================================
-- OPTIONAL BACKFILL - assigns one picture per level, levels 2-21.
-- Run this manually, only if/when you want to seed unlock_level values
-- onto the 20 existing preset_avatars rows, in a deterministic order
-- (oldest picture first). Leaves any picture beyond the first 20 at the
-- default unlock_level = 1.
-- ============================================================
-- with ranked as (
--   select id, row_number() over (order by created_at) + 1 as lvl
--   from public.preset_avatars
-- )
-- update public.preset_avatars pa
-- set unlock_level = ranked.lvl
-- from ranked
-- where pa.id = ranked.id;
