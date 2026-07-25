-- ============================================================
--  "N baking" — who is mid-session right now
-- ------------------------------------------------------------
--  A sessions row is only written when a session COMPLETES, so
--  there was previously nothing in the database that said "this
--  chef is baking right now". Every live-count pill had to be
--  hardcoded to 0.
--
--  One nullable timestamp on profiles fixes that: set it when a
--  timer starts, clear it when the timer ends or is abandoned.
--
--  Why a timestamp and not a boolean: people close the app or lose
--  their phone mid-session and the flag never gets cleared. Reading
--  it as "started within the last N hours" means a stale row ages
--  out on its own instead of inflating the count forever.
--
--  No new write policy is needed - schema.sql already has
--  "users can update their own profile", and a chef only ever sets
--  their own value. Reads ride on the existing profile-visibility
--  rules: friends see friends, the admin sees everyone.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

alter table public.profiles
  add column if not exists baking_since timestamptz;

-- Partial index: the vast majority of rows are null at any moment, and the
-- only query is "who is currently baking".
create index if not exists profiles_baking_since_idx
  on public.profiles (baking_since)
  where baking_since is not null;

-- ---------- group member list now reports live baking ----------
-- Replaces the version in migration_groups.sql, adding baking_since so a
-- group's detail screen can show how many of its members are baking.
create or replace function public.group_members_list(group_id uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  role text,
  weekly_pizzas numeric,
  baking_since timestamptz
)
language sql
security definer set search_path = public
as $$
  select
    gm.user_id,
    p.display_name,
    p.avatar_url,
    gm.role,
    coalesce((
      select sum(s.pizzas) from public.sessions s
      where s.user_id = gm.user_id
        and s.completed_at >= date_trunc('week', now())
    ), 0) as weekly_pizzas,
    p.baking_since
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = group_members_list.group_id
    and public.is_group_member(group_members_list.group_id)
  order by weekly_pizzas desc, p.display_name asc;
$$;

grant execute on function public.group_members_list(uuid) to authenticated;

-- ---------- my_groups now reports each group's live baking count ----------
-- Replaces the version in migration_groups.sql. Return-type changes need the
-- old function dropped first; `create or replace` cannot widen the signature.
drop function if exists public.my_groups();
create or replace function public.my_groups()
returns table (
  group_id uuid,
  name text,
  emoji text,
  privacy text,
  join_code text,
  role text,
  member_count bigint,
  weekly_pizzas numeric,
  baking_count bigint
)
language sql
security definer set search_path = public
stable
as $$
  select
    g.id,
    g.name,
    g.emoji,
    g.privacy,
    g.join_code,
    gm.role,
    (select count(*) from public.group_members gm2 where gm2.group_id = g.id) as member_count,
    coalesce((
      select sum(s.pizzas)
      from public.sessions s
      join public.group_members gm3 on gm3.user_id = s.user_id
      where gm3.group_id = g.id
        and s.completed_at >= date_trunc('week', now())
    ), 0) as weekly_pizzas,
    (
      select count(*)
      from public.group_members gm4
      join public.profiles p on p.id = gm4.user_id
      where gm4.group_id = g.id
        -- same 4h staleness cutoff the client uses, so an abandoned
        -- session ages out instead of counting forever
        and p.baking_since is not null
        and p.baking_since > now() - interval '4 hours'
    ) as baking_count
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.user_id = auth.uid()
  order by g.name asc;
$$;

grant execute on function public.my_groups() to authenticated;
