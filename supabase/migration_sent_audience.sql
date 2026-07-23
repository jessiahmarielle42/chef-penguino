-- Chef Penguino: audience tag for the admin "Sent" notifications history.
-- Run once in the Supabase SQL Editor, AFTER migration_unsend_messages.sql.
--
-- Additive / re-runnable (IF NOT EXISTS, CREATE OR REPLACE), so this whole
-- file is safe to run more than once.

-- =================================================================
-- 1. system_notifications gains an audience tag
-- =================================================================
-- Distinguishes a broadcast ('everyone') from a send to specific chefs
-- ('specific'), so the admin's Sent tab can show "Everyone" vs "N chefs"
-- without re-deriving it from batch size. No backfill: rows that predate
-- this migration are left null on purpose - the app already treats a null
-- audience the same as 'specific' (the non-"everyone" case), which is
-- exactly what those older sends were.
alter table public.system_notifications add column if not exists audience text;

-- =================================================================
-- 2. send_system_notification / broadcast_system_notification now stamp
--    audience alongside the existing batch_id
-- =================================================================
-- Bodies copied verbatim from migration_unsend_messages.sql (which already
-- set batch_id) with one addition: also insert audience.
create or replace function public.send_system_notification(target_ids uuid[], title text, body text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  new_batch uuid := gen_random_uuid();
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  if coalesce(btrim(title), '') = '' or coalesce(btrim(body), '') = '' then
    raise exception 'Title and message cannot be empty';
  end if;
  insert into public.system_notifications (user_id, title, body, batch_id, audience)
  select unnest(target_ids), title, body, new_batch, 'specific';
end;
$$;
revoke all on function public.send_system_notification(uuid[], text, text) from public, anon;
grant execute on function public.send_system_notification(uuid[], text, text) to authenticated;

create or replace function public.broadcast_system_notification(title text, body text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  new_batch uuid := gen_random_uuid();
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  if coalesce(btrim(title), '') = '' or coalesce(btrim(body), '') = '' then
    raise exception 'Title and message cannot be empty';
  end if;
  -- Fan-out: one row per user, so each person gets their own independent
  -- read-state instead of a shared row + separate read-receipts table.
  insert into public.system_notifications (user_id, title, body, batch_id, audience)
  select id, title, body, new_batch, 'everyone' from public.profiles;
end;
$$;
revoke all on function public.broadcast_system_notification(text, text) from public, anon;
grant execute on function public.broadcast_system_notification(text, text) to authenticated;
