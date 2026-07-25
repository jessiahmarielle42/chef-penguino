-- ============================================================
--  Live "is this chef name free?" check
-- ------------------------------------------------------------
--  The rename popup needs to tell you a name is taken BEFORE you hit
--  Save, instead of surfacing a unique-constraint violation after.
--
--  It can't just query public.profiles: RLS only exposes your own row
--  and your friends', so a name held by a stranger would look free and
--  the check would lie. This is a security definer function so it can
--  see every row - but it only ever returns a BOOLEAN, never any
--  profile data, so it can't be used to enumerate chefs.
--
--  Matching is case-insensitive to line up with the unique index from
--  migration_unique_names.sql, and your own current name always counts
--  as available so re-saving an unchanged name isn't blocked.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

create or replace function public.is_display_name_available(candidate text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select not exists (
    select 1 from public.profiles
    where lower(display_name) = lower(trim(candidate))
      and id is distinct from auth.uid()
  );
$$;

grant execute on function public.is_display_name_available(text) to authenticated;
