-- ============================================================
--  Unique chef display names (case-insensitive)
-- ------------------------------------------------------------
--  Two chefs could previously share an identical display name -
--  nothing enforced it. This adds a case-insensitive uniqueness
--  constraint, so "Waddles" and "waddles" collide.
--
--  Renaming away from a name immediately frees it for someone else -
--  that's just what a plain uniqueness constraint gives you, no
--  reservation/locking table needed.
--
--  SAFETY: if any two existing rows already share a name (case-
--  insensitively), creating the index would fail outright. The first
--  step finds and resolves those collisions - keeping the OLDEST row's
--  name as-is and appending a short numeric suffix to every later
--  duplicate - before the index is created, so this migration is safe
--  to run even if such rows already exist.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select id, rn
    from (
      select id, row_number() over (
        partition by lower(display_name)
        order by created_at asc, id asc
      ) as rn
      from public.profiles
      where display_name is not null and display_name <> ''
    ) dupes
    where dupes.rn > 1
  loop
    -- rn is already distinct within each colliding group (2, 3, 4, ...),
    -- so appending it can't create a fresh collision among the duplicates
    -- being fixed. A collision against some OTHER unrelated name is
    -- possible in principle but exceedingly unlikely for a short numeric
    -- suffix; the unique index below still catches it if it ever happens.
    update public.profiles
      set display_name = display_name || r.rn
      where id = r.id;
  end loop;
end $$;

drop index if exists profiles_display_name_unique_idx;
create unique index profiles_display_name_unique_idx
  on public.profiles (lower(display_name))
  where display_name is not null and display_name <> '';
