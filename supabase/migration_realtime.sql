-- Chef Penguino: enable Supabase Realtime for social notifications
-- Run once in the Supabase SQL Editor (after the noots + coin_gifts tables
-- exist). This lets the client receive an instant push when someone Noots
-- you or gifts you a coin, instead of only seeing it on app reload.
--
-- RLS still applies to realtime, so each client only receives rows where it
-- is the recipient.
--
-- If a table is already in the publication, Postgres raises
-- "relation is already member of publication" - that's harmless, it just
-- means it was added before.

alter publication supabase_realtime add table public.noots;
alter publication supabase_realtime add table public.coin_gifts;
