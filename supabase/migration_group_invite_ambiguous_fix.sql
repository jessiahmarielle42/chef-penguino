-- ============================================================
--  Fix: column reference "group_id" is ambiguous  (sending a group invite)
-- ------------------------------------------------------------
--  Symptom: tapping Send on "Invite friends" fails with
--      column reference "group_id" is ambiguous
--
--  Cause: both functions below take a parameter called group_id, and both
--  end their INSERT with an ON CONFLICT inference clause naming the
--  group_id COLUMN:
--
--      on conflict (group_id, invited_user_id) do nothing;
--
--  PL/pgSQL substitutes its own variables into expressions before the
--  planner sees them, and the conflict-target clause is one of the places
--  it looks. So `group_id` there matches both the function's parameter and
--  the table's column, and Postgres refuses to guess. Every other
--  reference in these functions is already written as
--  `function_name.param`, which is why nothing else in the groups feature
--  hit this - the conflict target is the one spot that can't be qualified
--  that way (Postgres does not accept a table-qualified name there).
--
--  Fix: `#variable_conflict use_column`, the documented resolution for
--  exactly this case. Bare names resolve to columns; the parameters are
--  still reachable as invite_to_group.group_id / respond_to_group_invite
--  .group_id, which is how this code already refers to them throughout.
--  Rewriting the INSERTs to avoid ON CONFLICT would have worked too, but
--  would have traded away the atomic dedupe on a double-tap.
--
--  Only respond_to_group_invite's failure hadn't been seen yet: it fires
--  when an invited chef ACCEPTS, which nobody could reach while sending
--  was broken. Fixed here so it doesn't surface as a second bug report.
--
--  The function bodies are otherwise byte-identical to
--  migration_groups_repair.sql, which has been corrected to match.
--
--  Idempotent - safe to run more than once.
--  Run this in the Supabase SQL Editor.
-- ============================================================

-- ---- owner invites a chef ----
create or replace function public.invite_to_group(group_id uuid, target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
#variable_conflict use_column
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
#variable_conflict use_column
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

grant execute on function public.invite_to_group(uuid, uuid)             to authenticated;
grant execute on function public.respond_to_group_invite(uuid, boolean)  to authenticated;

-- ---------- verify ----------
-- Both should come back with prosrc containing 'use_column'.
select p.proname, (position('use_column' in p.prosrc) > 0) as fixed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('invite_to_group', 'respond_to_group_invite')
order by p.proname;
