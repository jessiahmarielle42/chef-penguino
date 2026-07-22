-- Chef Penguino: block a user + report a user
-- Run once in the Supabase SQL Editor after schema.sql + migration_noots.sql.
--
-- Blocking removes the current friendship (both directions) and prevents
-- either side from re-adding the other via friend code, which also cuts off
-- Noots and coin gifts since both require an active friends row. Reporting
-- is independent of blocking - a user can report without blocking, or block
-- without reporting.

-- ---------- blocked_users ----------
-- blocked_name is a snapshot of the blocked user's display name at block
-- time, so the "Blocked Users" list in Settings can render without needing
-- a profiles RLS grant for a user you're no longer friends with.
create table public.blocked_users (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  blocked_name text not null default '',
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

create policy "users can see who they've blocked"
  on public.blocked_users for select
  using (blocker_id = auth.uid());

-- No direct insert/delete policies - both go through the security-definer
-- functions below, which keep the friends table in sync atomically.

-- ---------- reports ----------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  details text,
  created_at timestamptz not null default now(),
  check (reporter_id <> reported_id)
);

alter table public.reports enable row level security;

create policy "users can see their own reports"
  on public.reports for select
  using (reporter_id = auth.uid());

create policy "admin can view all reports"
  on public.reports for select
  using (auth.email() = 'keefefons@gmail.com');

-- No update/delete policies - reports are an append-only log for the admin
-- to review; insert goes through report_user() below.

-- ---------- block a user (removes friendship both directions) ----------
create or replace function public.block_user(target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_name text;
begin
  if target_id = auth.uid() then
    raise exception 'You cannot block yourself';
  end if;

  select display_name into target_name from public.profiles where id = target_id;

  delete from public.friends where user_id = auth.uid() and friend_id = target_id;
  delete from public.friends where user_id = target_id and friend_id = auth.uid();

  insert into public.blocked_users (blocker_id, blocked_id, blocked_name)
    values (auth.uid(), target_id, coalesce(target_name, ''))
    on conflict (blocker_id, blocked_id) do nothing;
end;
$$;

-- ---------- unblock a user ----------
create or replace function public.unblock_user(target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.blocked_users where blocker_id = auth.uid() and blocked_id = target_id;
end;
$$;

-- ---------- report a user ----------
create or replace function public.report_user(target_id uuid, reason text, details text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if target_id = auth.uid() then
    raise exception 'You cannot report yourself';
  end if;

  insert into public.reports (reporter_id, reported_id, reason, details)
  values (auth.uid(), target_id, reason, details);
end;
$$;

-- ---------- add_friend_by_code now also blocks re-adding across a block ----------
-- (redeclares the function from schema.sql with one added check)
create or replace function public.add_friend_by_code(code text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_id uuid;
  is_blocked boolean;
begin
  select id into target_id from public.profiles where friend_code = upper(code);

  if target_id is null then
    raise exception 'No user found with that friend code';
  end if;

  if target_id = auth.uid() then
    raise exception 'You cannot add yourself';
  end if;

  select exists(
    select 1 from public.blocked_users
    where (blocker_id = auth.uid() and blocked_id = target_id)
       or (blocker_id = target_id and blocked_id = auth.uid())
  ) into is_blocked;
  if is_blocked then
    raise exception 'Unable to add this friend';
  end if;

  insert into public.friends (user_id, friend_id) values (auth.uid(), target_id)
    on conflict do nothing;
  insert into public.friends (user_id, friend_id) values (target_id, auth.uid())
    on conflict do nothing;
end;
$$;
