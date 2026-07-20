-- One-off: credit 1.59 pizzas to jessiahmarielle@gmail.com
-- (Earlier attempt targeted "jesssiahmarielle@gmail.com" - three s's - which
-- doesn't match any account, so that insert silently affected 0 rows even
-- though the query ran without error. This version checks the email exists
-- and raises a clear error in the SQL Editor if it doesn't, instead of
-- quietly doing nothing.)
--
-- This only works if she has signed in with Google at least once already
-- (so her auth.users row + auto-created profiles row exist).
-- Run this once in the Supabase SQL Editor.

do $$
declare
  target_id uuid;
begin
  select id into target_id from auth.users where email = 'jessiahmarielle@gmail.com';

  if target_id is null then
    raise exception 'No auth.users row found for jessiahmarielle@gmail.com - she must sign in with Google at least once first';
  end if;

  insert into public.sessions (user_id, completed_at, minutes, pizzas, task)
  values (target_id, now(), round(1.59 * 60), 1.59, 'Manual credit (forgot to sign in)');
end $$;

-- The bump_pizzas trigger on public.sessions will automatically add
-- 1.59 to her profiles.pizzas total. To double check it landed, run:
-- select display_name, pizzas from public.profiles where id = (select id from auth.users where email = 'jessiahmarielle@gmail.com');
