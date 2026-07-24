-- ============================================================
--  Groups (kitchens chefs can bake together in)
-- ------------------------------------------------------------
--  Three tables:
--    groups         - the group itself (name, emoji, privacy, code)
--    group_members  - who's in it and their role (owner/member)
--    group_invites  - pending owner-issued invites
--
--  Permission model - deliberately minimal:
--    * public group  -> join_group() is INSTANT for any signed-in chef, and
--        the group is discoverable by name via discover_groups().
--    * private group -> NOT discoverable at all. The only ways in are an
--        owner's invite_to_group() (accepted via respond_to_group_invite())
--        or a join code.
--    * join_group_by_code() is ALWAYS instant, for public AND private
--        groups. Sharing the code IS the permission system - that's why
--        there's no approval/request flow anywhere in this file. A code
--        holder is trusted the same way a friend code is trusted elsewhere
--        in this app.
--
--  Role permissions - just two roles, owner and member:
--    * owner:  edit settings, invite, remove members, delete the group.
--    * member: can only leave.
--    * there is no admin role, no promotion/demotion, and no ownership
--      transfer - the owner cannot leave_group(); they must delete_group()
--      instead.
--    * blocked pairs (public.blocked_users) can't invite their way into
--      the same group as each other.
--
--  RLS + recursion note: a select policy on group_members that itself
--  queries group_members would recurse infinitely (policy -> triggers
--  policy -> triggers policy ...). To avoid that, all policies below go
--  through small SECURITY DEFINER helper functions (is_group_member,
--  group_role, is_group_owner) which read group_members directly and
--  bypass RLS entirely (that's what SECURITY DEFINER does), so they never
--  re-trigger the policy that's calling them.
--
--  Discovery (browsing public groups you're not in) goes through the
--  SECURITY DEFINER discover_groups() function rather than a broad select
--  policy, so the base table's RLS can stay tight (members only) while
--  still letting the client render a "Join" affordance. discover_groups()
--  only ever returns public groups - private groups never appear there.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

-- ---------- 1. tables ----------

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text,
  privacy text not null default 'private' check (privacy in ('public', 'private')),
  join_code text unique not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  invited_user_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, invited_user_id)
);

create index if not exists group_members_user_idx on public.group_members (user_id);
create index if not exists group_invites_invitee_idx on public.group_invites (invited_user_id);

-- Converge an existing database to the new shape: the join-request feature
-- and the join_mode/description columns no longer exist.
drop table if exists public.group_join_requests cascade;
alter table public.groups drop column if exists join_mode;
alter table public.groups drop column if exists description;

-- ---------- 2. row level security ----------
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;

-- ---------- 3. recursion-safe helper functions ----------
-- SECURITY DEFINER makes these bypass RLS when they read group_members, so
-- policies that call them don't re-trigger their own (or each other's)
-- select policy. Keep these read-only and cheap - they run per-row.

create or replace function public.is_group_member(gid uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = auth.uid()
  );
$$;

create or replace function public.group_role(gid uuid)
returns text
language sql
security definer set search_path = public
stable
as $$
  select gm.role from public.group_members gm
  where gm.group_id = gid and gm.user_id = auth.uid();
$$;

drop function if exists public.is_group_admin(uuid);

create or replace function public.is_group_owner(gid uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = auth.uid() and gm.role = 'owner'
  );
$$;

-- ---------- 4. table policies ----------
-- All writes go through the SECURITY DEFINER RPCs below (section 6), which
-- validate permissions and keep rows consistent atomically - no direct
-- insert/update/delete policies on any of these three tables.

drop policy if exists "groups are visible to members" on public.groups;
create policy "groups are visible to members"
  on public.groups for select
  using (public.is_group_member(id));

drop policy if exists "group members are visible to fellow members" on public.group_members;
create policy "group members are visible to fellow members"
  on public.group_members for select
  using (public.is_group_member(group_id));

drop policy if exists "join requests visible to requester and group admins" on public.group_join_requests;

drop policy if exists "invites visible to invitee and group admins" on public.group_invites;
drop policy if exists "invites visible to invitee and group owner" on public.group_invites;
create policy "invites visible to invitee and group owner"
  on public.group_invites for select
  using (
    invited_user_id = auth.uid()
    or public.is_group_owner(group_id)
  );

-- ---------- 5. join code generator ----------
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

-- ---------- 6. RPC functions ----------
-- Function parameter names below sometimes collide with column names of
-- the same name (e.g. a `group_id` parameter vs. `group_members.group_id`).
-- Where that happens, references to the parameter are qualified as
-- `function_name.param` (PL/pgSQL treats the function's own name as the
-- label of its outer block), and references to columns go through a table
-- alias, so there is never any ambiguity.

drop function if exists public.request_to_join_group(uuid);
drop function if exists public.respond_to_join_request(uuid, uuid, boolean);
drop function if exists public.set_group_member_role(uuid, uuid, text);
drop function if exists public.regenerate_group_code(uuid);
drop function if exists public.group_join_requests_for_admin();
drop function if exists public.create_group(text, text, text, text, text);
drop function if exists public.update_group_settings(uuid, text, text, text, text, text);
drop function if exists public.my_groups();
drop function if exists public.discover_groups(text);
drop function if exists public.group_members_list(uuid);

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

-- ---------- 7. read functions (for the UI) ----------

-- Groups I'm in, with my role, member count and combined weekly pizzas.
create or replace function public.my_groups()
returns table (
  group_id uuid,
  name text,
  emoji text,
  privacy text,
  join_code text,
  role text,
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
    g.join_code,
    gm.role,
    (select count(*) from public.group_members gm2 where gm2.group_id = g.id) as member_count,
    coalesce((
      select sum(s.pizzas)
      from public.sessions s
      join public.group_members gm3 on gm3.user_id = s.user_id
      where gm3.group_id = g.id
        and s.completed_at >= date_trunc('week', now())
    ), 0) as weekly_pizzas
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.user_id = auth.uid()
  order by g.name asc;
$$;

-- PUBLIC groups I'm NOT in, searchable by name. Private groups never appear
-- here - that's the whole point of privacy = 'private'. Deliberately omits
-- join_code - same reasoning as search_chefs() omitting friend_code: a code
-- is only meant to reach someone who was actually given it, not surfaced
-- through open search.
create or replace function public.discover_groups(q text default '')
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
        and s.completed_at >= date_trunc('week', now())
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

-- Members of a group (leaderboard + owner member-management screen).
-- Caller must be a member.
create or replace function public.group_members_list(group_id uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz,
  weekly_pizzas numeric
)
language plpgsql
security definer set search_path = public
stable
as $$
begin
  if not public.is_group_member(group_members_list.group_id) then
    raise exception 'You must be a member of this group to view its members';
  end if;

  return query
  select
    p.id,
    p.display_name,
    p.avatar_url,
    gm.role,
    gm.joined_at,
    coalesce((
      select sum(s.pizzas) from public.sessions s
      where s.user_id = p.id
        and s.completed_at >= date_trunc('week', now())
    ), 0) as weekly_pizzas
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = group_members_list.group_id
  order by weekly_pizzas desc, p.display_name asc;
end;
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

-- ---------- 8. grants ----------
grant execute on function public.is_group_member(uuid)                          to authenticated;
grant execute on function public.group_role(uuid)                               to authenticated;
grant execute on function public.is_group_owner(uuid)                           to authenticated;
grant execute on function public.generate_group_code()                          to authenticated;
grant execute on function public.create_group(text, text, text)                 to authenticated;
grant execute on function public.join_group(uuid)                               to authenticated;
grant execute on function public.join_group_by_code(text)                       to authenticated;
grant execute on function public.invite_to_group(uuid, uuid)                    to authenticated;
grant execute on function public.respond_to_group_invite(uuid, boolean)         to authenticated;
grant execute on function public.update_group_settings(uuid, text, text, text)  to authenticated;
grant execute on function public.remove_group_member(uuid, uuid)                to authenticated;
grant execute on function public.leave_group(uuid)                              to authenticated;
grant execute on function public.delete_group(uuid)                             to authenticated;
grant execute on function public.my_groups()                                    to authenticated;
grant execute on function public.discover_groups(text)                          to authenticated;
grant execute on function public.group_members_list(uuid)                       to authenticated;
grant execute on function public.my_group_invites()                             to authenticated;
