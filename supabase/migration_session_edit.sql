-- Lets users rename/re-icon and delete their own session log entries.
-- Run this once in the Supabase SQL Editor.

alter table public.sessions add column if not exists icon text;

create policy "users can update their own sessions"
  on public.sessions for update
  using (user_id = auth.uid());

create policy "users can delete their own sessions"
  on public.sessions for delete
  using (user_id = auth.uid());

-- Mirrors bump_pizzas (which runs on insert) so deleting a session also
-- removes the pizzas it contributed, keeping the lifetime total accurate.
create or replace function public.unbump_pizzas()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles set pizzas = pizzas - old.pizzas where id = old.user_id;
  return old;
end;
$$;

create trigger on_session_deleted
  after delete on public.sessions
  for each row execute function public.unbump_pizzas();
