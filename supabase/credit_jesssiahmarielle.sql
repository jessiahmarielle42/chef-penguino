-- One-off: credit 1.09 pizzas to jesssiahmarielle@gmail.com
-- She did a focus session without being signed in, so it was never recorded.
-- This only works if she has signed in with Google at least once already
-- (so her auth.users row + auto-created profiles row exist).
-- Run this once in the Supabase SQL Editor.

insert into public.sessions (user_id, completed_at, minutes, pizzas, task)
select
  u.id,
  now(),
  round(1.09 * 60),
  1.09,
  'Manual credit (forgot to sign in)'
from auth.users u
where u.email = 'jesssiahmarielle@gmail.com';

-- The bump_pizzas trigger on public.sessions will automatically add
-- 1.09 to her profiles.pizzas total.
