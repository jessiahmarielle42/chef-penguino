-- Chef Penguino: profiles, session log, and friends
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query -> Run)

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  friend_code text unique not null,
  pizzas numeric not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are visible to self and friends"
  on public.profiles for select
  using (
    id = auth.uid()
    or id in (select friend_id from public.friends where user_id = auth.uid())
  );

create policy "users can update their own profile"
  on public.profiles for update
  using (id = auth.uid());

-- ---------- sessions (the pizza log) ----------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  completed_at timestamptz not null,
  minutes numeric not null,
  pizzas numeric not null,
  task text not null default '',
  created_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

create policy "sessions are visible to self and friends"
  on public.sessions for select
  using (
    user_id = auth.uid()
    or user_id in (select friend_id from public.friends where user_id = auth.uid())
  );

create policy "users can insert their own sessions"
  on public.sessions for insert
  with check (user_id = auth.uid());

-- ---------- friends (mutual link: one row per direction) ----------
create table public.friends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, friend_id),
  check (user_id <> friend_id)
);

alter table public.friends enable row level security;

create policy "users can see their own friend list"
  on public.friends for select
  using (user_id = auth.uid());

-- No direct insert/update/delete policies for `friends` - all changes go
-- through the security-definer functions below, which validate the friend
-- code and keep both directions of the relationship in sync atomically.

-- ---------- auto-create a profile + friend code on signup ----------
create or replace function public.generate_friend_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I/L
  code text;
  exists_already boolean;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
    end loop;
    select exists(select 1 from public.profiles where friend_code = code) into exists_already;
    exit when not exists_already;
  end loop;
  return code;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, friend_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    public.generate_friend_code()
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- add / remove friend (bypasses RLS safely via security definer) ----------
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

  if target_id = auth.uid() then
    raise exception 'You cannot add yourself';
  end if;

  insert into public.friends (user_id, friend_id) values (auth.uid(), target_id)
    on conflict do nothing;
  insert into public.friends (user_id, friend_id) values (target_id, auth.uid())
    on conflict do nothing;
end;
$$;

create or replace function public.remove_friend(target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.friends where user_id = auth.uid() and friend_id = target_id;
  delete from public.friends where user_id = target_id and friend_id = auth.uid();
end;
$$;

-- ---------- keep profiles.pizzas in sync whenever a session is inserted ----------
create or replace function public.bump_pizzas()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles set pizzas = pizzas + new.pizzas where id = new.user_id;
  return new;
end;
$$;

create trigger on_session_inserted
  after insert on public.sessions
  for each row execute function public.bump_pizzas();
