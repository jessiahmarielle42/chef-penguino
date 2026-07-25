-- ============================================================
--  Friend requests + directory search
-- ------------------------------------------------------------
--  Previously add_friend_by_code() inserted BOTH directions of the
--  friendship immediately. Since RLS grants friends read access to
--  each other's sessions and profile, knowing someone's code was
--  enough to start reading their focus history - the code was doing
--  the job of a permission check without ever asking anyone.
--
--  Chefs can now also be found by name, so this makes consent
--  explicit. BOTH routes create a pending request:
--
--    search  -> +    sends a request
--    friend code     sends a request
--
--  The code identifies WHICH chef you mean; approving is what grants
--  access. Nobody reads your sessions until you tap Approve.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

-- ---------- 1. status column on friends ----------
alter table public.friends
  add column if not exists status text not null default 'accepted'
    check (status in ('pending', 'accepted'));

-- Who initiated, so a pending row is only actionable by the recipient.
alter table public.friends
  add column if not exists requested_by uuid references public.profiles(id) on delete cascade;

alter table public.friends
  add column if not exists created_at timestamptz not null default now();

-- Existing friendships predate requests and stay accepted (the default
-- above already handles this; stated explicitly for clarity on re-runs).
update public.friends set status = 'accepted' where status is null;

create index if not exists friends_status_idx on public.friends (user_id, status);

-- ---------- 2. RLS: only ACCEPTED friendships grant visibility ----------
-- Without this the pending row itself would leak sessions/profile.
drop policy if exists "sessions are visible to self and friends" on public.sessions;
create policy "sessions are visible to self and friends"
  on public.sessions for select
  using (
    user_id = auth.uid()
    or user_id in (
      select friend_id from public.friends
      where user_id = auth.uid() and status = 'accepted'
    )
  );

drop policy if exists "profiles are visible to self and friends" on public.profiles;
create policy "profiles are visible to self and friends"
  on public.profiles for select
  using (
    id = auth.uid()
    or id in (
      select friend_id from public.friends
      where user_id = auth.uid() and status = 'accepted'
    )
  );

-- ---------- 3. Chef search (Friends tab) ----------
-- Deliberately NARROW: name, avatar, weekly score. No friend_code —
-- strangers must not be able to harvest codes and bypass approval.
-- No email, no session detail.
create or replace function public.search_chefs(q text default '', lim int default 50)
returns table (
  id uuid,
  display_name text,
  avatar_url text,
  weekly_pizzas numeric,
  relationship text
)
language sql
security definer set search_path = public
as $$
  select
    p.id,
    p.display_name,
    p.avatar_url,
    coalesce((
      select sum(s.pizzas) from public.sessions s
      where s.user_id = p.id
        and s.completed_at >= date_trunc('week', now())
    ), 0) as weekly_pizzas,
    case
      when p.id = auth.uid() then 'self'
      when exists (
        select 1 from public.friends f
        where f.user_id = auth.uid() and f.friend_id = p.id and f.status = 'accepted'
      ) then 'friend'
      when exists (
        select 1 from public.friends f
        where f.user_id = auth.uid() and f.friend_id = p.id and f.status = 'pending'
      ) then 'outgoing'
      when exists (
        select 1 from public.friends f
        where f.user_id = p.id and f.friend_id = auth.uid() and f.status = 'pending'
      ) then 'incoming'
      else 'none'
    end as relationship
  from public.profiles p
  where auth.uid() is not null
    and (q = '' or p.display_name ilike '%' || q || '%')
    -- never surface anyone on either side of a block
    and not exists (
      select 1 from public.blocked_users b
      where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
         or (b.blocker_id = p.id and b.blocked_id = auth.uid())
    )
  order by weekly_pizzas desc, p.display_name asc
  limit least(lim, 200);
$$;

-- ---------- 4. Send a request (search -> ＋) ----------
create or replace function public.send_friend_request(target_id uuid)
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
  if target_id = auth.uid() then
    raise exception 'You cannot add yourself';
  end if;

  select exists(
    select 1 from public.blocked_users
    where (blocker_id = auth.uid() and blocked_id = target_id)
       or (blocker_id = target_id and blocked_id = auth.uid())
  ) into is_blocked;
  if is_blocked then
    raise exception 'Unable to add this chef';
  end if;

  -- Already accepted either way? Nothing to do.
  if exists (
    select 1 from public.friends
    where user_id = auth.uid() and friend_id = target_id and status = 'accepted'
  ) then
    return;
  end if;

  -- They already asked you: approving is the natural resolution.
  if exists (
    select 1 from public.friends
    where user_id = target_id and friend_id = auth.uid() and status = 'pending'
  ) then
    perform public.respond_to_friend_request(target_id, true);
    return;
  end if;

  -- One pending row, owned by the requester. The recipient sees it via
  -- incoming_friend_requests() below.
  insert into public.friends (user_id, friend_id, status, requested_by)
  values (auth.uid(), target_id, 'pending', auth.uid())
  on conflict do nothing;
end;
$$;

-- ---------- 5. Approve / decline ----------
create or replace function public.respond_to_friend_request(requester_id uuid, accept boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  -- Only the RECIPIENT of a pending request may answer it.
  if not exists (
    select 1 from public.friends
    where user_id = requester_id and friend_id = auth.uid() and status = 'pending'
  ) then
    raise exception 'No pending request from this chef';
  end if;

  if accept then
    update public.friends
      set status = 'accepted'
      where user_id = requester_id and friend_id = auth.uid();
    -- Mirror row so both sides see each other.
    insert into public.friends (user_id, friend_id, status, requested_by)
    values (auth.uid(), requester_id, 'accepted', requester_id)
    on conflict (user_id, friend_id) do update set status = 'accepted';
  else
    delete from public.friends
      where user_id = requester_id and friend_id = auth.uid() and status = 'pending';
  end if;
end;
$$;

-- ---------- 6. Incoming requests (for the Friends tab) ----------
create or replace function public.incoming_friend_requests()
returns table (
  requester_id uuid,
  display_name text,
  avatar_url text,
  requested_at timestamptz
)
language sql
security definer set search_path = public
as $$
  select f.user_id, p.display_name, p.avatar_url, f.created_at
  from public.friends f
  join public.profiles p on p.id = f.user_id
  where f.friend_id = auth.uid()
    and f.status = 'pending'
  order by f.created_at desc;
$$;

-- ---------- 7. Code path also sends a request ----------
-- Both ways in (search and code) now go through approval. The code says
-- WHICH chef you mean; the approval is what actually grants access. That
-- matters because friendship is what RLS uses to expose session history -
-- nobody should be able to read yours without you tapping Approve.
create or replace function public.add_friend_by_code(code text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_id uuid;
begin
  select id into target_id from public.profiles where friend_code = upper(code);

  if target_id is null then
    raise exception 'No user found with that friend code';
  end if;

  -- send_friend_request re-checks blocks, existing friendship, and the
  -- "they already asked you" case, so there is nothing to duplicate here.
  perform public.send_friend_request(target_id);
end;
$$;

grant execute on function public.search_chefs(text, int)               to authenticated;
grant execute on function public.send_friend_request(uuid)             to authenticated;
grant execute on function public.respond_to_friend_request(uuid, bool) to authenticated;
grant execute on function public.incoming_friend_requests()            to authenticated;
