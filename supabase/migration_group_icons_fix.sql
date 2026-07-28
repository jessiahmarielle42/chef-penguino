-- Fix: "column reference emoji is ambiguous" when adding a group icon from
-- Admin -> Group Icons.
--
-- add_group_icon(emoji text) takes a parameter with the same name as the
-- group_icons.emoji column, so a bare `emoji` inside the body is ambiguous -
-- Postgres can't tell the parameter from the column and raises rather than
-- guessing. remove_group_icon(id uuid) has exactly the same problem with
-- group_icons.id.
--
-- Fixed by copying each parameter into a distinctly-named local variable and
-- using only that in the statement, plus `#variable_conflict use_variable` so
-- any remaining bare reference resolves to the variable rather than erroring.
-- The column list of an INSERT - the `(emoji)` below - is always column names
-- and is never ambiguous, so it stays as-is.
--
-- Parameter NAMES are deliberately unchanged (still `emoji` and `id`): the app
-- calls these by keyword, supabase.rpc('add_group_icon', { emoji }), so
-- renaming them would break the client until both sides deployed together.
-- create or replace keeps the same signature, so no drop is needed.
--
-- Run this once in the Supabase SQL Editor.

create or replace function public.add_group_icon(emoji text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
#variable_conflict use_variable
declare
  new_id uuid;
  v_emoji text := emoji;
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  insert into public.group_icons (emoji) values (v_emoji) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.remove_group_icon(id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
#variable_conflict use_variable
declare
  v_id uuid := id;
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.group_icons where group_icons.id = v_id;
end;
$$;

grant execute on function public.add_group_icon(text) to authenticated;
grant execute on function public.remove_group_icon(uuid) to authenticated;
