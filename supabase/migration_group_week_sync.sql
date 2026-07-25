-- ============================================================
--  Sync the group leaderboard's week boundary to the client's clock
-- ------------------------------------------------------------
--  group_members_list() and my_groups() both computed "this week" as
--  date_trunc('week', now()), which runs in the DATABASE's timezone
--  (UTC on Supabase). The Friends leaderboard instead uses the
--  browser's local Monday (startOfThisWeek() in main.js).
--
--  Those agree most of the time, but not everywhere: at UTC+8, UTC
--  Monday 00:00 is Monday 08:00 local, so for that 8-hour window each
--  Monday the Friends board has already reset for the new week while
--  every group board hasn't - a Sunday-night session could count on
--  one leaderboard and not the other.
--
--  Both functions now take an optional week_start timestamptz. The
--  client passes its own local Monday 00:00; omitting it keeps the old
--  UTC-week behaviour, so this stays backward compatible with any
--  caller that doesn't pass it yet.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

drop function if exists public.group_members_list(uuid);
create or replace function public.group_members_list(group_id uuid, week_start timestamptz default date_trunc('week', now()))
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
        and s.completed_at >= group_members_list.week_start
    ), 0) as weekly_pizzas,
    p.baking_since
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = group_members_list.group_id
    and public.is_group_member(group_members_list.group_id)
  order by weekly_pizzas desc, p.display_name asc;
$$;

drop function if exists public.my_groups();
create or replace function public.my_groups(week_start timestamptz default date_trunc('week', now()))
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
        and s.completed_at >= my_groups.week_start
    ), 0) as weekly_pizzas,
    (
      select count(*)
      from public.group_members gm4
      join public.profiles p on p.id = gm4.user_id
      where gm4.group_id = g.id
        and p.baking_since is not null
        and p.baking_since > now() - interval '4 hours'
    ) as baking_count
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.user_id = auth.uid()
  order by g.name asc;
$$;

grant execute on function public.group_members_list(uuid, timestamptz) to authenticated;
grant execute on function public.my_groups(timestamptz) to authenticated;
