-- One-off: grant +1 Penguino Coin to keefe@thatbiotutor.com for testing the
-- gifting feature. Uses coin_adjustment (not pizzas), so the lifetime pizza
-- count is untouched.
--
-- Requires migration_coin_gifts.sql to have been run first (it adds the
-- coin_adjustment column). Run this once in the Supabase SQL Editor.

do $$
declare
  target_id uuid;
begin
  select id into target_id from auth.users where email = 'keefe@thatbiotutor.com';

  if target_id is null then
    raise exception 'No auth.users row for keefe@thatbiotutor.com - sign in with Google at least once first';
  end if;

  update public.profiles set coin_adjustment = coin_adjustment + 1 where id = target_id;
end $$;

-- Verify:
-- select display_name, coin_adjustment from public.profiles
-- where id = (select id from auth.users where email = 'keefe@thatbiotutor.com');
