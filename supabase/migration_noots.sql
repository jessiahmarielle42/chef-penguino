-- Chef Penguino: "Nooting" (poking a friend)
-- Run once in the Supabase SQL Editor after schema.sql + migration_emotes.sql.

create table public.noots (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  check (sender_id <> recipient_id)
);

alter table public.noots enable row level security;

create policy "users can see noots they sent or received"
  on public.noots for select
  using (sender_id = auth.uid() or recipient_id = auth.uid());

-- No direct insert/update policies - both go through the security-definer
-- functions below, which enforce the friendship + cooldown rules atomically.

-- ---------- send a noot (validates friendship + one-pending-at-a-time) ----------
create or replace function public.send_noot(target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  are_friends boolean;
  already_pending boolean;
begin
  if target_id = auth.uid() then
    raise exception 'You cannot Noot yourself';
  end if;

  select exists(
    select 1 from public.friends where user_id = auth.uid() and friend_id = target_id
  ) into are_friends;
  if not are_friends then
    raise exception 'You can only Noot a friend';
  end if;

  select exists(
    select 1 from public.noots
    where sender_id = auth.uid() and recipient_id = target_id and acknowledged_at is null
  ) into already_pending;
  if already_pending then
    raise exception 'Wait for them to see your last Noot first';
  end if;

  insert into public.noots (sender_id, recipient_id) values (auth.uid(), target_id);
end;
$$;

-- ---------- acknowledge a received noot ("Got it!") ----------
create or replace function public.acknowledge_noot(noot_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.noots set acknowledged_at = now()
  where id = noot_id and recipient_id = auth.uid() and acknowledged_at is null;
end;
$$;
