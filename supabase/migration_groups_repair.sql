-- ============================================================
--  REPAIR: finish the half-applied groups migration
-- ------------------------------------------------------------
--  Symptom: tapping "Create group" fails with
--    PGRST202 - Could not find the function public.create_group(
--    emoji, name, privacy) in the schema cache
--  and the Groups tab shows "Groups aren't available yet".
--
--  Cause: migration_groups.sql aborts partway through, every time.
--  Line 82 does
--      drop table if exists public.group_join_requests cascade;
--  and then line ~148 does
--      drop policy if exists "..." on public.group_join_requests;
--  In `DROP POLICY IF EXISTS ... ON <table>` the IF EXISTS guards the
--  POLICY, not the TABLE - so once that table is gone (which line 82
--  guarantees) the statement raises
--      ERROR: relation "public.group_join_requests" does not exist
--  and the script stops right there.
--
--  Everything BEFORE that line is live in the database today: the
--  groups / group_members / group_invites tables, is_group_member(),
--  group_role(), is_group_owner(), and the SELECT policies on groups
--  and group_members. Everything AFTER it never ran - which is all
--  twelve write/read RPCs the Groups UI actually calls, plus the
--  group_invites SELECT policy.
--
--  This file creates exactly the missing pieces and nothing else, so
--  it is safe to run on the current database. It deliberately does NOT
--  re-create my_groups() or group_members_list() - the week-synced
--  versions from migration_group_week_sync.sql are already correct and
--  live, and adding the older no-arg / one-arg overloads back would
--  make PostgREST ambiguous (PGRST203) about which one to call.
--
--  Idempotent - safe to run more than once.
--
--  Run this in the Supabase SQL Editor.
--  (Do NOT re-run migration_groups.sql; it will just abort again.)
-- ============================================================

-- ---------- 0. (removed - this section was harmful) ----------
-- This file used to open with
--     drop function if exists public.my_groups();
--     drop function if exists public.group_members_list(uuid);
-- described as no-ops meant to clear stale overloads, on the assumption
-- that the live signatures were the week-synced my_groups(timestamptz) /
-- group_members_list(uuid, timestamptz) which those DROPs would not match.
--
-- That assumption was wrong on the real database: migration_baking_now.sql
-- had been run but migration_group_week_sync.sql had not, so the live
-- functions still WERE the zero-arg / one-arg versions - and these two
-- statements deleted them, taking out the whole Groups tab.
--
-- Removed rather than corrected. Dropping a function to pre-empt a
-- hypothetical overload is not worth the risk of deleting the live one;
-- if migration_groups.sql is ever replayed and creates a duplicate, fix it
-- then, against the signatures actually present.

-- ---------- 1. the SELECT policy that never got created ----------
-- Without this, RLS hides every row of group_invites, so an invited chef
-- sees nothing in their Requests tab even when the invite exists.
drop policy if exists "invites visible to invitee and group admins" on public.group_invites;
drop policy if exists "invites visible to invitee and group owner" on public.group_invites;
create policy "invites visible to invitee and group owner"
  on public.group_invites for select
  using (
    invited_user_id = auth.uid()
    or public.is_group_owner(group_id)
  );

-- ---------- 2. join code generator ----------
-- Same alphabet/shape as generate_friend_code() in schema.sql (no 0/O/1/I/L).
create or replace function public.generate_group_code()
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  exists_already boolean;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
    end loop;
    select exists(select 1 from public.groups where join_code = code) into exists_already;
    exit when not exists_already;
  end loop;
  return code;
end;
$$;

-- ---------- 3. write RPCs ----------
-- Parameter names below sometimes collide with column names of the same
-- name (e.g. a `group_id` parameter vs. group_members.group_id). Where that
-- happens the parameter is qualified as `function_name.param` (PL/pgSQL
-- treats the function's own name as the label of its outer block) and
-- columns go through a table alias, so there is never any ambiguity.

-- ---- create a group ----
create or replace function public.create_group(
  name text,
  emoji text default null,
  privacy text default 'private'
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_id uuid;
  new_code text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if coalesce(trim(create_group.name), '') = '' then
    raise exception 'Group name is required';
  end if;
  if create_group.privacy not in ('public', 'private') then
    raise exception 'Invalid privacy value';
  end if;

  new_code := public.generate_group_code();

  insert into public.groups (name, emoji, privacy, join_code, created_by)
  values (trim(create_group.name), create_group.emoji, create_group.privacy, new_code, auth.uid())
  returning id into new_id;

  insert into public.group_members (group_id, user_id, role)
  values (new_id, auth.uid(), 'owner');

  return new_id;
end;
$$;

-- ---- instant join, PUBLIC groups only ----
create or replace function public.join_group(group_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  g public.groups%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into g from public.groups where id = join_group.group_id;
  if g.id is null then
    raise exception 'Group not found';
  end if;

  if exists (
    select 1 from public.group_members gm
    where gm.group_id = g.id and gm.user_id = auth.uid()
  ) then
    return; -- already a member, no-op
  end if;

  if g.privacy <> 'public' then
    raise exception 'This group is private - you need a join code or an invite';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (g.id, auth.uid(), 'member');

  -- Clean up any stale pending invite now that they're just in.
  delete from public.group_invites gi where gi.group_id = g.id and gi.invited_user_id = auth.uid();
end;
$$;

-- ---- instant join by code, ALWAYS works (public or private) ----
-- The code is the consent mechanism, so this deliberately skips the
-- privacy check that join_group() enforces.
create or replace function public.join_group_by_code(code text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  g public.groups%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into g from public.groups where join_code = upper(join_group_by_code.code);
  if g.id is null then
    raise exception 'No group found with that code';
  end if;

  if exists (
    select 1 from public.group_members gm
    where gm.group_id = g.id and gm.user_id = auth.uid()
  ) then
    return g.id; -- already a member
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (g.id, auth.uid(), 'member');

  delete from public.group_invites gi where gi.group_id = g.id and gi.invited_user_id = auth.uid();

  return g.id;
end;
$$;

-- ---- owner invites a chef ----
create or replace function public.invite_to_group(group_id uuid, target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  is_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_group_owner(invite_to_group.group_id) then
    raise exception 'Only the group owner can invite chefs';
  end if;

  if invite_to_group.target_id = auth.uid() then
    raise exception 'You cannot invite yourself';
  end if;

  if exists (
    select 1 from public.group_members gm
    where gm.group_id = invite_to_group.group_id and gm.user_id = invite_to_group.target_id
  ) then
    raise exception 'This chef is already a member';
  end if;

  select exists(
    select 1 from public.blocked_users b
    where (b.blocker_id = auth.uid() and b.blocked_id = invite_to_group.target_id)
       or (b.blocker_id = invite_to_group.target_id and b.blocked_id = auth.uid())
  ) into is_blocked;
  if is_blocked then
    raise exception 'Unable to invite this chef';
  end if;

  insert into public.group_invites (group_id, invited_user_id, invited_by)
  values (invite_to_group.group_id, invite_to_group.target_id, auth.uid())
  on conflict (group_id, invited_user_id) do nothing;
end;
$$;

-- ---- invited chef accepts/declines ----
create or replace function public.respond_to_group_invite(group_id uuid, accept boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if not exists (
    select 1 from public.group_invites gi
    where gi.group_id = respond_to_group_invite.group_id
      and gi.invited_user_id = auth.uid()
  ) then
    raise exception 'No pending invite to this group';
  end if;

  if respond_to_group_invite.accept then
    insert into public.group_members (group_id, user_id, role)
    values (respond_to_group_invite.group_id, auth.uid(), 'member')
    on conflict (group_id, user_id) do nothing;
  end if;

  delete from public.group_invites gi
  where gi.group_id = respond_to_group_invite.group_id
    and gi.invited_user_id = auth.uid();
end;
$$;

-- ---- owner edits group settings ----
create or replace function public.update_group_settings(
  group_id uuid,
  name text,
  emoji text,
  privacy text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  caller_role text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  caller_role := public.group_role(update_group_settings.group_id);
  if caller_role is distinct from 'owner' then
    raise exception 'Only the group owner can edit group settings';
  end if;

  if coalesce(trim(update_group_settings.name), '') = '' then
    raise exception 'Group name is required';
  end if;
  if update_group_settings.privacy not in ('public', 'private') then
    raise exception 'Invalid privacy value';
  end if;

  update public.groups g
  set name = trim(update_group_settings.name),
      emoji = update_group_settings.emoji,
      privacy = update_group_settings.privacy
  where g.id = update_group_settings.group_id;
end;
$$;

-- ---- owner removes a member; the owner cannot remove themselves this way ----
create or replace function public.remove_group_member(group_id uuid, target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  caller_role text;
  target_role text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  caller_role := public.group_role(remove_group_member.group_id);
  -- caller_role is null for non-members; "caller_role <> 'owner'" evaluates
  -- to null (falsy in an IF), so the null case must be checked explicitly
  -- or a non-member could slip past this guard.
  if caller_role is distinct from 'owner' then
    raise exception 'Only the group owner can remove members';
  end if;

  if remove_group_member.target_id = auth.uid() then
    raise exception 'The owner cannot remove themselves - delete the group instead';
  end if;

  select gm.role into target_role
  from public.group_members gm
  where gm.group_id = remove_group_member.group_id
    and gm.user_id = remove_group_member.target_id;

  if target_role is null then
    raise exception 'That chef is not a member of this group';
  end if;

  delete from public.group_members gm
  where gm.group_id = remove_group_member.group_id
    and gm.user_id = remove_group_member.target_id;
end;
$$;

-- ---- leave a group; the owner cannot leave and must delete the group instead ----
create or replace function public.leave_group(group_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  caller_role text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  caller_role := public.group_role(leave_group.group_id);
  if caller_role is null then
    raise exception 'You are not a member of this group';
  end if;

  if caller_role = 'owner' then
    raise exception 'The owner cannot leave a group - delete the group instead';
  end if;

  delete from public.group_members gm
  where gm.group_id = leave_group.group_id and gm.user_id = auth.uid();
end;
$$;

-- ---- owner deletes the group ----
create or replace function public.delete_group(group_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if public.group_role(delete_group.group_id) is distinct from 'owner' then
    raise exception 'Only the group owner can delete this group';
  end if;

  -- group_members / group_invites cascade via FK.
  delete from public.groups g where g.id = delete_group.group_id;
end;
$$;

-- ---------- 4. read RPCs ----------

-- Public groups I'm not already in.
-- week_start matches the change made to my_groups()/group_members_list() in
-- migration_group_week_sync.sql: the client passes its own local Monday so
-- every leaderboard in the app agrees on where the week starts, instead of
-- this one silently using the database's UTC week. Defaulted, so an older
-- client that doesn't pass it still works.
drop function if exists public.discover_groups(text);
create or replace function public.discover_groups(
  q text default '',
  week_start timestamptz default date_trunc('week', now())
)
returns table (
  group_id uuid,
  name text,
  emoji text,
  privacy text,
  member_count bigint,
  weekly_pizzas numeric
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
    (select count(*) from public.group_members gm2 where gm2.group_id = g.id) as member_count,
    coalesce((
      select sum(s.pizzas)
      from public.sessions s
      join public.group_members gm3 on gm3.user_id = s.user_id
      where gm3.group_id = g.id
        and s.completed_at >= discover_groups.week_start
    ), 0) as weekly_pizzas
  from public.groups g
  where auth.uid() is not null
    and g.privacy = 'public'
    and (discover_groups.q = '' or g.name ilike '%' || discover_groups.q || '%')
    and not exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id = auth.uid()
    )
  order by member_count desc, g.name asc
  limit 100;
$$;

-- Pending invites addressed to me.
create or replace function public.my_group_invites()
returns table (
  group_id uuid,
  name text,
  emoji text,
  invited_by_name text,
  created_at timestamptz
)
language sql
security definer set search_path = public
stable
as $$
  select g.id, g.name, g.emoji, p.display_name, gi.created_at
  from public.group_invites gi
  join public.groups g on g.id = gi.group_id
  join public.profiles p on p.id = gi.invited_by
  where gi.invited_user_id = auth.uid()
  order by gi.created_at desc;
$$;

-- ---------- 5. seed the group icon palette ----------
-- group_icons exists but is empty, so the "Group icon" picker in the
-- Create a group popup came up blank. The app now falls back to a default
-- set client-side, but seeding real rows means the admin can actually
-- curate them in Admin -> Group Icons. No unique constraint on emoji, so
-- each insert is guarded rather than using ON CONFLICT.
insert into public.group_icons (emoji)
select e from (values ('🐧'),('🍕'),('🔥'),('⭐'),('🏆'),('🎉'),('📚'),('🌙'),('☀️'),('🧠'),('💪'),('☕')) as v(e)
where not exists (select 1 from public.group_icons gi where gi.emoji = v.e);

-- ---------- 6. grants ----------
grant execute on function public.generate_group_code()                        to authenticated;
grant execute on function public.create_group(text, text, text)               to authenticated;
grant execute on function public.join_group(uuid)                             to authenticated;
grant execute on function public.join_group_by_code(text)                     to authenticated;
grant execute on function public.invite_to_group(uuid, uuid)                  to authenticated;
grant execute on function public.respond_to_group_invite(uuid, boolean)       to authenticated;
grant execute on function public.update_group_settings(uuid, text, text, text) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid)              to authenticated;
grant execute on function public.leave_group(uuid)                            to authenticated;
grant execute on function public.delete_group(uuid)                           to authenticated;
grant execute on function public.discover_groups(text, timestamptz)           to authenticated;
grant execute on function public.my_group_invites()                           to authenticated;

-- ---------- 7. verify ----------
-- Should list all 12 function names below. Anything missing means that
-- statement didn't apply.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'generate_group_code','create_group','join_group','join_group_by_code',
    'invite_to_group','respond_to_group_invite','update_group_settings',
    'remove_group_member','leave_group','delete_group','discover_groups',
    'my_group_invites','my_groups','group_members_list'
  )
order by p.proname;
