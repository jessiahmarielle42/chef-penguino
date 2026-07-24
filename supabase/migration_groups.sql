-- ============================================================
--  Groups (kitchens chefs can bake together in)
-- ------------------------------------------------------------
--  Four new tables:
--    groups              - the group itself (name, privacy, join_mode, code)
--    group_members        - who's in it and their role (owner/admin/member)
--    group_join_requests  - pending "let me in" asks for private+request groups
--    group_invites        - pending admin-issued invites for invite-only groups
--
--  Permission model:
--    * public group             -> join_group() is INSTANT for anyone signed in.
--    * private + join_mode='request' -> request_to_join_group() creates a
--        request; an owner/admin must respond_to_join_request().
--    * private + join_mode='invite'  -> no requests allowed at all; only an
--        owner/admin can invite_to_group(), and the invitee accepts/declines
--        via respond_to_group_invite().
--    * join_group_by_code() is ALWAYS instant, for public AND private groups,
--        no matter the join_mode. Sharing the code is treated as consent -
--        same rule this app already uses for friend codes.
--
--  Role permissions:
--    * owner/admin: edit settings, invite, approve/decline requests, remove
--      members, regenerate the join code.
--    * owner only:  promote/demote admins, transfer ownership, delete group.
--    * an admin can never remove the owner or another admin.
--    * the owner can't just leave - they must transfer ownership (or delete
--      the group) first.
--    * blocked pairs (public.blocked_users) can't invite / request their way
--      into the same group as each other.
--
--  RLS + recursion note: a select policy on group_members that itself
--  queries group_members would recurse infinitely (policy -> triggers
--  policy -> triggers policy ...). To avoid that, all policies below go
--  through small SECURITY DEFINER helper functions (is_group_member,
--  group_role, is_group_admin) which read group_members directly and
--  bypass RLS entirely (that's what SECURITY DEFINER does), so they never
--  re-trigger the policy that's calling them.
--
--  Discovery (browsing groups you're not in, including private ones) goes
--  through the SECURITY DEFINER discover_groups() function rather than a
--  broad select policy, so the base table's RLS can stay tight (members
--  only) while still letting the client render "Join" / "Request to join" /
--  "Invite-only" affordances correctly.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

-- ---------- 1. tables ----------

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  emoji text,
  privacy text not null default 'private' check (privacy in ('public', 'private')),
  -- join_mode only matters when privacy = 'private'; public groups are
  -- always instant-join regardless of what's stored here.
  join_mode text not null default 'request' check (join_mode in ('request', 'invite')),
  join_code text unique not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.group_join_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
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
create index if not exists group_join_requests_group_idx on public.group_join_requests (group_id);
create index if not exists group_invites_invitee_idx on public.group_invites (invited_user_id);

-- ---------- 2. row level security ----------
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_join_requests enable row level security;
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

create or replace function public.is_group_admin(gid uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = auth.uid() and gm.role in ('owner', 'admin')
  );
$$;

-- ---------- 4. table policies ----------
-- All writes go through the SECURITY DEFINER RPCs below (section 6), which
-- validate permissions and keep rows consistent atomically - no direct
-- insert/update/delete policies on any of these four tables.

drop policy if exists "groups are visible to members" on public.groups;
create policy "groups are visible to members"
  on public.groups for select
  using (public.is_group_member(id));

drop policy if exists "group members are visible to fellow members" on public.group_members;
create policy "group members are visible to fellow members"
  on public.group_members for select
  using (public.is_group_member(group_id));

drop policy if exists "join requests visible to requester and group admins" on public.group_join_requests;
create policy "join requests visible to requester and group admins"
  on public.group_join_requests for select
  using (
    user_id = auth.uid()
    or public.is_group_admin(group_id)
  );

drop policy if exists "invites visible to invitee and group admins" on public.group_invites;
create policy "invites visible to invitee and group admins"
  on public.group_invites for select
  using (
    invited_user_id = auth.uid()
    or public.is_group_admin(group_id)
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

-- ---- create a group ----
create or replace function public.create_group(
  name text,
  description text default null,
  emoji text default null,
  privacy text default 'private',
  join_mode text default 'request'
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
  if create_group.join_mode not in ('request', 'invite') then
    raise exception 'Invalid join mode';
  end if;

  new_code := public.generate_group_code();

  insert into public.groups (name, description, emoji, privacy, join_mode, join_code, created_by)
  values (trim(create_group.name), create_group.description, create_group.emoji,
          create_group.privacy, create_group.join_mode, new_code, auth.uid())
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
    raise exception 'This group is private - request to join or use a join code';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (g.id, auth.uid(), 'member');

  -- Clean up any stale pending request/invite now that they're just in.
  delete from public.group_join_requests gr where gr.group_id = g.id and gr.user_id = auth.uid();
  delete from public.group_invites gi where gi.group_id = g.id and gi.invited_user_id = auth.uid();
end;
$$;

-- ---- instant join by code, ALWAYS works (public or private, any join_mode) ----
-- The code is the consent mechanism, so this deliberately skips every
-- privacy/join_mode/request check that join_group() and
-- request_to_join_group() enforce.
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

  delete from public.group_join_requests gr where gr.group_id = g.id and gr.user_id = auth.uid();
  delete from public.group_invites gi where gi.group_id = g.id and gi.invited_user_id = auth.uid();

  return g.id;
end;
$$;

-- ---- request to join, PRIVATE + join_mode='request' only ----
create or replace function public.request_to_join_group(group_id uuid)
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

  select * into g from public.groups where id = request_to_join_group.group_id;
  if g.id is null then
    raise exception 'Group not found';
  end if;

  if exists (
    select 1 from public.group_members gm
    where gm.group_id = g.id and gm.user_id = auth.uid()
  ) then
    raise exception 'You are already a member of this group';
  end if;

  if g.privacy = 'public' then
    raise exception 'This group is public - just join it directly';
  end if;

  if g.join_mode <> 'request' then
    raise exception 'This group is invite-only - ask an owner/admin to invite you, or use a join code';
  end if;

  -- Blocked pairs can't request their way into each other's groups: reject
  -- if the requester is blocked with (or has blocked) any current
  -- owner/admin of the group.
  if exists (
    select 1
    from public.group_members gm
    join public.blocked_users b
      on (b.blocker_id = auth.uid() and b.blocked_id = gm.user_id)
      or (b.blocker_id = gm.user_id and b.blocked_id = auth.uid())
    where gm.group_id = g.id and gm.role in ('owner', 'admin')
  ) then
    raise exception 'Unable to request to join this group';
  end if;

  insert into public.group_join_requests (group_id, user_id)
  values (g.id, auth.uid())
  on conflict (group_id, user_id) do nothing;
end;
$$;

-- ---- owner/admin approves or declines a join request ----
create or replace function public.respond_to_join_request(group_id uuid, requester_id uuid, accept boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_group_admin(respond_to_join_request.group_id) then
    raise exception 'Only group owners/admins can respond to join requests';
  end if;

  if not exists (
    select 1 from public.group_join_requests gr
    where gr.group_id = respond_to_join_request.group_id
      and gr.user_id = respond_to_join_request.requester_id
  ) then
    raise exception 'No pending join request from this chef';
  end if;

  if respond_to_join_request.accept then
    insert into public.group_members (group_id, user_id, role)
    values (respond_to_join_request.group_id, respond_to_join_request.requester_id, 'member')
    on conflict (group_id, user_id) do nothing;
  end if;

  delete from public.group_join_requests gr
  where gr.group_id = respond_to_join_request.group_id
    and gr.user_id = respond_to_join_request.requester_id;
end;
$$;

-- ---- owner/admin invites a chef ----
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

  if not public.is_group_admin(invite_to_group.group_id) then
    raise exception 'Only group owners/admins can invite chefs';
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

-- ---- owner/admin edits group settings ----
create or replace function public.update_group_settings(
  group_id uuid,
  name text,
  description text,
  emoji text,
  privacy text,
  join_mode text
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_group_admin(update_group_settings.group_id) then
    raise exception 'Only group owners/admins can edit group settings';
  end if;

  if coalesce(trim(update_group_settings.name), '') = '' then
    raise exception 'Group name is required';
  end if;
  if update_group_settings.privacy not in ('public', 'private') then
    raise exception 'Invalid privacy value';
  end if;
  if update_group_settings.join_mode not in ('request', 'invite') then
    raise exception 'Invalid join mode';
  end if;

  update public.groups g
  set name = trim(update_group_settings.name),
      description = update_group_settings.description,
      emoji = update_group_settings.emoji,
      privacy = update_group_settings.privacy,
      join_mode = update_group_settings.join_mode
  where g.id = update_group_settings.group_id;
end;
$$;

-- ---- owner promotes/demotes members; setting new_role='owner' transfers ownership ----
create or replace function public.set_group_member_role(group_id uuid, target_id uuid, new_role text)
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

  caller_role := public.group_role(set_group_member_role.group_id);
  if caller_role is distinct from 'owner' then
    raise exception 'Only the group owner can change member roles';
  end if;

  if set_group_member_role.new_role not in ('owner', 'admin', 'member') then
    raise exception 'Invalid role';
  end if;

  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = set_group_member_role.group_id
      and gm.user_id = set_group_member_role.target_id
  ) then
    raise exception 'That chef is not a member of this group';
  end if;

  if set_group_member_role.target_id = auth.uid() and set_group_member_role.new_role <> 'owner' then
    raise exception 'Transfer ownership to someone else before stepping down';
  end if;

  if set_group_member_role.new_role = 'owner' then
    -- Ownership transfer: there is only ever one owner, so the current
    -- owner is demoted to admin as part of the same transfer.
    update public.group_members gm
    set role = 'admin'
    where gm.group_id = set_group_member_role.group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner';

    update public.group_members gm
    set role = 'owner'
    where gm.group_id = set_group_member_role.group_id
      and gm.user_id = set_group_member_role.target_id;
  else
    update public.group_members gm
    set role = set_group_member_role.new_role
    where gm.group_id = set_group_member_role.group_id
      and gm.user_id = set_group_member_role.target_id;
  end if;
end;
$$;

-- ---- owner/admin removes a member; admin can't remove owner or another admin ----
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
  -- caller_role is null for non-members; "null not in (...)" evaluates to
  -- null (falsy in an IF), so the null case must be checked explicitly or
  -- a non-member could slip past this guard.
  if caller_role is null or caller_role not in ('owner', 'admin') then
    raise exception 'Only group owners/admins can remove members';
  end if;

  if remove_group_member.target_id = auth.uid() then
    raise exception 'Use leave_group to remove yourself';
  end if;

  select gm.role into target_role
  from public.group_members gm
  where gm.group_id = remove_group_member.group_id
    and gm.user_id = remove_group_member.target_id;

  if target_role is null then
    raise exception 'That chef is not a member of this group';
  end if;

  if target_role = 'owner' then
    raise exception 'The owner cannot be removed - they must transfer ownership or delete the group';
  end if;

  if caller_role = 'admin' and target_role = 'admin' then
    raise exception 'Admins cannot remove other admins';
  end if;

  delete from public.group_members gm
  where gm.group_id = remove_group_member.group_id
    and gm.user_id = remove_group_member.target_id;
end;
$$;

-- ---- leave a group; the owner must transfer ownership (or delete) first ----
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
    raise exception 'Transfer ownership to another member (or delete the group) before leaving';
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

  -- group_members / group_join_requests / group_invites cascade via FK.
  delete from public.groups g where g.id = delete_group.group_id;
end;
$$;

-- ---- owner/admin regenerates the join code ----
create or replace function public.regenerate_group_code(group_id uuid)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  new_code text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if not public.is_group_admin(regenerate_group_code.group_id) then
    raise exception 'Only group owners/admins can regenerate the join code';
  end if;

  new_code := public.generate_group_code();

  update public.groups g
  set join_code = new_code
  where g.id = regenerate_group_code.group_id;

  return new_code;
end;
$$;

-- ---------- 7. read functions (for the UI) ----------

-- Groups I'm in, with my role, member count and combined weekly pizzas.
create or replace function public.my_groups()
returns table (
  group_id uuid,
  name text,
  description text,
  emoji text,
  privacy text,
  join_mode text,
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
    g.description,
    g.emoji,
    g.privacy,
    g.join_mode,
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

-- Groups I'm NOT in, searchable by name. Deliberately omits join_code -
-- same reasoning as search_chefs() omitting friend_code: a code is only
-- meant to reach someone who was actually given it, not surfaced through
-- open search.
create or replace function public.discover_groups(q text default '')
returns table (
  group_id uuid,
  name text,
  description text,
  emoji text,
  privacy text,
  join_mode text,
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
    g.description,
    g.emoji,
    g.privacy,
    g.join_mode,
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
    and (discover_groups.q = '' or g.name ilike '%' || discover_groups.q || '%')
    and not exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id = auth.uid()
    )
  order by member_count desc, g.name asc
  limit 100;
$$;

-- Members of a group (leaderboard + admin member-management screen).
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

-- Pending join requests across every group where I'm owner/admin.
create or replace function public.group_join_requests_for_admin()
returns table (
  group_id uuid,
  group_name text,
  requester_id uuid,
  requester_name text,
  requester_avatar_url text,
  created_at timestamptz
)
language sql
security definer set search_path = public
stable
as $$
  select gr.group_id, g.name, gr.user_id, p.display_name, p.avatar_url, gr.created_at
  from public.group_join_requests gr
  join public.groups g on g.id = gr.group_id
  join public.profiles p on p.id = gr.user_id
  where public.is_group_admin(gr.group_id)
  order by gr.created_at desc;
$$;

-- ---------- 8. grants ----------
grant execute on function public.is_group_member(uuid)                          to authenticated;
grant execute on function public.group_role(uuid)                               to authenticated;
grant execute on function public.is_group_admin(uuid)                           to authenticated;
grant execute on function public.generate_group_code()                          to authenticated;
grant execute on function public.create_group(text, text, text, text, text)     to authenticated;
grant execute on function public.join_group(uuid)                               to authenticated;
grant execute on function public.join_group_by_code(text)                       to authenticated;
grant execute on function public.request_to_join_group(uuid)                    to authenticated;
grant execute on function public.respond_to_join_request(uuid, uuid, boolean)   to authenticated;
grant execute on function public.invite_to_group(uuid, uuid)                    to authenticated;
grant execute on function public.respond_to_group_invite(uuid, boolean)         to authenticated;
grant execute on function public.update_group_settings(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.set_group_member_role(uuid, uuid, text)        to authenticated;
grant execute on function public.remove_group_member(uuid, uuid)                to authenticated;
grant execute on function public.leave_group(uuid)                              to authenticated;
grant execute on function public.delete_group(uuid)                             to authenticated;
grant execute on function public.regenerate_group_code(uuid)                    to authenticated;
grant execute on function public.my_groups()                                    to authenticated;
grant execute on function public.discover_groups(text)                          to authenticated;
grant execute on function public.group_members_list(uuid)                       to authenticated;
grant execute on function public.my_group_invites()                             to authenticated;
grant execute on function public.group_join_requests_for_admin()                to authenticated;
