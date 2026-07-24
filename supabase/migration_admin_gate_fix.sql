-- Chef Penguino: SECURITY FIX for a null-email admin-gate bypass.
--
-- Several security-definer RPC functions gate admin-only access with:
--   if auth.email() <> 'keefefons@gmail.com' then raise exception ...
-- In Postgres, `null <> 'x'` evaluates to NULL, not TRUE. For an anonymous
-- (unauthenticated) caller, auth.email() is NULL, so the IF condition is
-- NULL, the `if` block is skipped, and the "Not authorised" exception never
-- fires. That means an anon caller could invoke these admin-only functions
-- and have the gate silently do nothing.
--
-- The fix: use `is distinct from` instead of `<>`. `x is distinct from y`
-- is null-safe - it returns TRUE whenever x and y are not the same value,
-- treating NULL as a normal, comparable value instead of propagating NULL.
-- So `auth.email() is distinct from 'keefefons@gmail.com'` is TRUE both when
-- the caller is a different authenticated user AND when auth.email() is
-- NULL (anon), correctly raising the exception in both cases.
--
-- This migration re-creates every affected function, verbatim, with only
-- that one-line gate fix applied. Run once in the Supabase SQL Editor.
-- Idempotent: every statement is `create or replace function`, so running
-- this more than once is safe.
--
-- NOTE on RLS policies: policies of the form
--   using (auth.email() = 'keefefons@gmail.com')
-- are NOT touched here. `null = 'x'` is NULL -> treated as FALSE by RLS,
-- which correctly DENIES access for an anon/null-email caller. Only the
-- `<>` form inside PL/pgSQL `if` guards is broken, because there an
-- unmatched (NULL) condition means "skip the exception" instead of "deny".

-- =================================================================
-- reports: dismiss_report(uuid, text)
-- Latest signature per migration_system_notifications.sql, which drops the
-- older single-arg version from migration_admin_warnings.sql.
-- =================================================================
create or replace function public.dismiss_report(report_id uuid, note text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.reports
    set status = 'dismissed', resolved_at = now(), resolved_by = auth.uid(), resolution = note
    where id = report_id and status = 'open';
end;
$$;
revoke all on function public.dismiss_report(uuid, text) from public, anon;
grant execute on function public.dismiss_report(uuid, text) to authenticated;

-- =================================================================
-- warnings: warn_user(uuid, text, uuid, text)
-- Latest signature per migration_system_notifications.sql, which drops the
-- older 2-arg version from migration_admin_warnings.sql.
-- =================================================================
create or replace function public.warn_user(target_id uuid, message text, report_id uuid default null, details text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  new_warning_id uuid;
  effective_details text := details;
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  if coalesce(btrim(message), '') = '' then
    raise exception 'Warning message cannot be empty';
  end if;

  -- If the caller didn't pass explicit details but this warning is resolving
  -- a specific report, copy that report's reason in automatically so the
  -- warned user has context without the admin re-typing it.
  if effective_details is null and report_id is not null then
    select reason into effective_details from public.reports where id = report_id;
  end if;

  insert into public.warnings (user_id, message, details, report_id)
    values (target_id, message, effective_details, report_id)
    returning id into new_warning_id;

  -- Warning resolves only the ONE report it was raised from (per-report,
  -- not a global "user is warned" flag) - a user's other open reports are
  -- left untouched in the queue.
  if report_id is not null then
    update public.reports
      set status = 'actioned', resolved_at = now(), resolved_by = auth.uid(), warning_id = new_warning_id
      where id = report_id and status = 'open';
  end if;
end;
$$;
revoke all on function public.warn_user(uuid, text, uuid, text) from public, anon;
grant execute on function public.warn_user(uuid, text, uuid, text) to authenticated;

-- =================================================================
-- bug_reports: flag_bug_report_for_claude(uuid)
-- =================================================================
create or replace function public.flag_bug_report_for_claude(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set sent_to_claude_at = now() where id = report_id;
end;
$$;

-- =================================================================
-- bug_reports: dismiss_bug_report(uuid)
-- =================================================================
create or replace function public.dismiss_bug_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set status = 'dismissed' where id = report_id;
end;
$$;

-- =================================================================
-- bug_reports: reply_bug_report(uuid, text)
-- =================================================================
create or replace function public.reply_bug_report(report_id uuid, message text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_reporter_id uuid;
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;

  select reporter_id into target_reporter_id from public.bug_reports where id = report_id;
  if target_reporter_id is null then
    raise exception 'Report not found';
  end if;

  update public.bug_reports
    set admin_reply = message, replied_at = now(), status = 'replied'
    where id = report_id;

  insert into public.system_notifications (user_id, title, body)
    values (target_reporter_id, 'Reply from the team', message);
end;
$$;

-- =================================================================
-- bug_reports: resolve_bug_report(uuid)
-- =================================================================
create or replace function public.resolve_bug_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set status = 'resolved' where id = report_id;
end;
$$;

-- =================================================================
-- bug_reports: unflag_bug_report_for_claude(uuid)
-- =================================================================
create or replace function public.unflag_bug_report_for_claude(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set sent_to_claude_at = null where id = report_id;
end;
$$;

-- =================================================================
-- system_notifications: send_system_notification(uuid[], text, text)
-- Latest body per migration_sent_audience.sql (stamps batch_id + audience),
-- superseding the earlier versions in migration_system_notifications.sql
-- and migration_unsend_messages.sql.
-- =================================================================
create or replace function public.send_system_notification(target_ids uuid[], title text, body text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  new_batch uuid := gen_random_uuid();
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
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

-- =================================================================
-- system_notifications: broadcast_system_notification(text, text)
-- Latest body per migration_sent_audience.sql (stamps batch_id + audience),
-- superseding the earlier versions in migration_system_notifications.sql
-- and migration_unsend_messages.sql.
-- =================================================================
create or replace function public.broadcast_system_notification(title text, body text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  new_batch uuid := gen_random_uuid();
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
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

-- =================================================================
-- system_notifications: mark_blocks_seen()
-- =================================================================
create or replace function public.mark_blocks_seen()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  insert into public.admin_meta (admin_id, blocks_seen_at)
    values (auth.uid(), now())
    on conflict (admin_id) do update set blocks_seen_at = excluded.blocks_seen_at;
end;
$$;
revoke all on function public.mark_blocks_seen() from public, anon;
grant execute on function public.mark_blocks_seen() to authenticated;

-- =================================================================
-- unsend_messages: unsend_system_notifications(uuid)
-- =================================================================
create or replace function public.unsend_system_notifications(p_batch_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.system_notifications where batch_id = p_batch_id;
end;
$$;
revoke all on function public.unsend_system_notifications(uuid) from public, anon;
grant execute on function public.unsend_system_notifications(uuid) to authenticated;

-- =================================================================
-- unsend_messages: unsend_warning(uuid)
-- =================================================================
create or replace function public.unsend_warning(p_warning_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.warnings where id = p_warning_id;
end;
$$;
revoke all on function public.unsend_warning(uuid) from public, anon;
grant execute on function public.unsend_warning(uuid) to authenticated;
