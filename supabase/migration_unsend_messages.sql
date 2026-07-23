-- Chef Penguino: "unsend" (hard delete) for admin-sent messages.
-- Run once in the Supabase SQL Editor, AFTER migration_system_notifications.sql.
--
-- Everything here is additive / re-runnable (IF NOT EXISTS, CREATE OR REPLACE,
-- and an idempotent backfill), so this whole file is safe to run more than once.

-- =================================================================
-- 1. system_notifications gains a batch_id - one send action, one id
-- =================================================================
-- A single admin send (broadcast to everyone, or a specific send to a handful
-- of chefs) fans out into one row per recipient. batch_id ties those rows
-- back together so the admin can unsend the whole send in one action instead
-- of hunting down every recipient's row individually.
alter table public.system_notifications add column if not exists batch_id uuid;

-- Backfill: rows that predate this migration have no batch_id yet. Treat each
-- existing row as its own one-off batch (its own id) so old History entries
-- still resolve to a single, unsendable batch_id. Guarded by "where batch_id
-- is null" so re-running this file is a no-op the second time.
update public.system_notifications set batch_id = id where batch_id is null;

-- =================================================================
-- 2. send_system_notification / broadcast_system_notification now stamp a
--    single shared batch_id per call
-- =================================================================
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
  insert into public.system_notifications (user_id, title, body, batch_id)
  select unnest(target_ids), title, body, new_batch;
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
  insert into public.system_notifications (user_id, title, body, batch_id)
  select id, title, body, new_batch from public.profiles;
end;
$$;
revoke all on function public.broadcast_system_notification(text, text) from public, anon;
grant execute on function public.broadcast_system_notification(text, text) to authenticated;

-- =================================================================
-- 3. unsend_system_notifications - admin deletes an entire send (batch)
-- =================================================================
-- Hard delete, on purpose: the whole point of "unsend" is that the message
-- vanishes from every recipient's System Notifications page and their
-- records entirely, not just gets hidden.
create or replace function public.unsend_system_notifications(p_batch_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.system_notifications where batch_id = p_batch_id;
end;
$$;
revoke all on function public.unsend_system_notifications(uuid) from public, anon;
grant execute on function public.unsend_system_notifications(uuid) to authenticated;

-- =================================================================
-- 4. unsend_warning - admin deletes a single warning
-- =================================================================
-- reports.warning_id is declared "on delete set null" (see
-- migration_system_notifications.sql), so a report that was actioned by this
-- warning simply loses the link and stays in its 'actioned' state - that's
-- acceptable, the audit trail on the report itself (resolved_at/resolved_by)
-- is untouched.
create or replace function public.unsend_warning(p_warning_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.warnings where id = p_warning_id;
end;
$$;
revoke all on function public.unsend_warning(uuid) from public, anon;
grant execute on function public.unsend_warning(uuid) to authenticated;
