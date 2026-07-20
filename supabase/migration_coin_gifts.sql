-- Chef Penguino: gifting Penguino Coins to friends
-- Run once in the Supabase SQL Editor after schema.sql + migration_emotes.sql
-- + migration_noots.sql.
--
-- Coins are otherwise fully DERIVED (floor(pizzas/12) - owned_emotes), so
-- there is no stored balance to move between players. This migration adds a
-- single signed `coin_adjustment` counter per profile:
--
--   balance = floor(pizzas/12) - (# owned emotes) + coin_adjustment
--
--   gift away  -> sender.coin_adjustment   -= 1
--   receive    -> recipient.coin_adjustment += 1
--
-- Buying an emote still just appends to owned_emotes, which naturally spends
-- a received/gifted coin too, so nothing can desync.

alter table public.profiles
  add column if not exists coin_adjustment integer not null default 0;

-- ---------- gift log (powers the "you received a coin" popup, like noots) ----------
create table if not exists public.coin_gifts (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  check (sender_id <> recipient_id)
);

alter table public.coin_gifts enable row level security;

create policy "users can see coin gifts they sent or received"
  on public.coin_gifts for select
  using (sender_id = auth.uid() or recipient_id = auth.uid());

-- No direct insert/update policies - everything goes through the
-- security-definer functions below, which enforce the rules atomically.

-- ---------- gift one coin (validates friendship + balance) ----------
create or replace function public.gift_coin(target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  are_friends boolean;
  sender_balance integer;
begin
  if target_id = auth.uid() then
    raise exception 'You cannot gift yourself';
  end if;

  select exists(
    select 1 from public.friends where user_id = auth.uid() and friend_id = target_id
  ) into are_friends;
  if not are_friends then
    raise exception 'You can only gift a friend';
  end if;

  -- Recompute the sender's real balance server-side so it can't be spoofed.
  select floor(pizzas / 12)::int - coalesce(array_length(owned_emotes, 1), 0) + coin_adjustment
    into sender_balance
    from public.profiles where id = auth.uid();

  if coalesce(sender_balance, 0) < 1 then
    raise exception 'Not enough coins to gift';
  end if;

  update public.profiles set coin_adjustment = coin_adjustment - 1 where id = auth.uid();
  update public.profiles set coin_adjustment = coin_adjustment + 1 where id = target_id;

  insert into public.coin_gifts (sender_id, recipient_id) values (auth.uid(), target_id);
end;
$$;

-- ---------- acknowledge a received gift ("Got it!") ----------
create or replace function public.acknowledge_coin_gift(gift_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.coin_gifts set acknowledged_at = now()
  where id = gift_id and recipient_id = auth.uid() and acknowledged_at is null;
end;
$$;
