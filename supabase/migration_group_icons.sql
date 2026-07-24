-- Group Icons: a curated, admin-managed set of emoji chefs will be able to
-- pick as a group's icon (see migration_groups.sql's groups.emoji column,
-- currently free text with no picker UI yet - this gives the admin a
-- curated palette to build that picker from). Run this once in the
-- Supabase SQL Editor.

create table if not exists public.group_icons (
  id uuid primary key default gen_random_uuid(),
  emoji text not null,
  created_at timestamptz not null default now()
);

alter table public.group_icons enable row level security;

-- Any signed-in chef can read the curated list (e.g. a future group-icon
-- picker); writes only ever go through the admin-gated RPCs below.
create policy "group icons are readable by authenticated users"
  on public.group_icons for select
  to authenticated
  using (true);

-- ---------- admin-only mutation RPCs ----------
-- `is distinct from` (not `<>`) so a null auth.email() (no JWT / anon call)
-- fails CLOSED - `<>` against NULL evaluates to NULL, which a plpgsql `if`
-- treats as false and would silently skip the exception instead of denying.
create or replace function public.add_group_icon(emoji text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  insert into public.group_icons (emoji) values (add_group_icon.emoji) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.remove_group_icon(id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.group_icons where group_icons.id = remove_group_icon.id;
end;
$$;

grant execute on function public.add_group_icon(text) to authenticated;
grant execute on function public.remove_group_icon(uuid) to authenticated;
