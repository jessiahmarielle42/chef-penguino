-- One-time backfill: give EXISTING admin pizza edits their equivalent focus
-- time (1 pizza = 1 hour), so day/week/month totals and each row's duration
-- reflect the adjustment. New admin edits already do this in the app.
--
-- Only rows that are currently 0-minute pizza adjustments are touched. Coin
-- admin edits (task 'Admin Edit (+N coin)', pizzas 0) and real sessions are
-- left alone. Run once in the Supabase SQL Editor.

update public.sessions
set minutes = round(pizzas * 60)
where task = 'Admin Edit'
  and pizzas <> 0
  and minutes = 0;
