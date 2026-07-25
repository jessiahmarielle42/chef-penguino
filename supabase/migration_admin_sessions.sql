-- Admin Dashboard: the new "Pizzas Baked" aggregate calendar (and the
-- "Pizzas baked today" KPI on Kitchen HQ) need to sum public.sessions
-- across EVERY chef, not just the admin's own + friends' rows.
--
-- migration_admin.sql already lets the admin read every row of
-- public.profiles, but never added the equivalent for public.sessions -
-- without this, RLS quietly limits admin queries to the admin's own (and
-- friends') sessions, so the aggregate totals under-count rather than
-- erroring. Run this once in the Supabase SQL Editor.

-- `=` is correct for a SELECT policy: a null auth.email() yields NULL, which
-- is not true, so an anonymous caller is denied rather than let through.
drop policy if exists "admin can view all sessions" on public.sessions;
create policy "admin can view all sessions"
  on public.sessions for select
  using (auth.email() = 'keefefons@gmail.com');
