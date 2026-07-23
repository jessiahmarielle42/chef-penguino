-- Chef Penguino: report lifecycle, warning read-state, and a proper
-- System Notifications mailbox for users, plus admin broadcasts.
-- Run once in the Supabase SQL Editor, after migration_block_report.sql,
-- migration_admin_warnings.sql and migration_admin_moderation.sql.
--
-- Everything here is additive (new columns / new tables / new or replaced
-- functions). No existing data is touched or deleted.

-- =================================================================
-- 1. reports gains a resolvable lifecycle
-- =================================================================
-- A report used to be deleted on dismiss (see the old dismiss_report below,
-- which we replace further down). Now it moves through a small state
-- machine and is kept forever as an audit trail:
--   open -> dismissed   (admin taps Dismiss, no user-visible effect)
--   open -> actioned    (admin sends a warning that resolves this report)
-- All ADD COLUMN / CREATE statements below use IF NOT EXISTS (and policies are
-- dropped-then-created) so this whole file is safe to re-run end to end if an
-- earlier hand-run died partway.
alter table public.reports
  add column if not exists status text not null default 'open'
    check (status in ('open', 'dismissed', 'actioned')),
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.profiles(id),
  add column if not exists resolution text,
  -- on delete set null: an actioned report links to its warning, but if that
  -- warning is ever removed (e.g. the warned user deletes their account, which
  -- cascades away their warnings) the audit report must survive, not block the
  -- delete.
  add column if not exists warning_id uuid references public.warnings(id) on delete set null;

-- =================================================================
-- 2. warnings gains details + its own "seen in the list" read-state
-- =================================================================
-- acknowledged_at already exists and means "user tapped 'I understand' on
-- the live popup" - that happens near-instantly on load, so it can't drive
-- an unread badge. read_at is a second, independent timestamp that's only
-- set when the user actually scrolls this specific message into view on
-- the System Notifications page (see mark_warning_read below).
alter table public.warnings
  add column if not exists details text,
  add column if not exists read_at timestamptz,
  -- on delete set null: same reasoning as reports.warning_id above - deleting a
  -- report (e.g. via reporter account cascade) must not be blocked by a warning
  -- that was raised from it.
  add column if not exists report_id uuid references public.reports(id) on delete set null;

-- Existing warnings predate the mailbox page entirely - treat them as
-- already-read so the new badge doesn't spike for old, already-acknowledged
-- warnings that a user has no reason to revisit.
update public.warnings set read_at = coalesce(acknowledged_at, created_at) where read_at is null;

-- =================================================================
-- 3. system_notifications - admin -> user announcements (no popup)
-- =================================================================
create table if not exists public.system_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

alter table public.system_notifications enable row level security;

drop policy if exists "users can see their own system notifications" on public.system_notifications;
create policy "users can see their own system notifications"
  on public.system_notifications for select
  using (user_id = auth.uid());

drop policy if exists "admin can view all system notifications" on public.system_notifications;
create policy "admin can view all system notifications"
  on public.system_notifications for select
  using (auth.email() = 'keefefons@gmail.com');

-- No insert policy - rows are only ever created through the security-definer
-- send_system_notification() / broadcast_system_notification() RPCs below,
-- same pattern as warnings/reports.

-- =================================================================
-- 4. admin_meta - tiny per-admin settings (currently just "blocks seen at")
-- =================================================================
-- Single admin today, but keyed by admin_id so this still works cleanly if
-- a second admin is ever added.
create table if not exists public.admin_meta (
  admin_id uuid primary key references public.profiles(id) on delete cascade,
  blocks_seen_at timestamptz not null default now()
);

alter table public.admin_meta enable row level security;

-- One "for all" policy covers select/insert/update/delete, so no separate
-- select policy is needed.
drop policy if exists "admin can manage admin_meta" on public.admin_meta;
create policy "admin can manage admin_meta"
  on public.admin_meta for all
  using (auth.email() = 'keefefons@gmail.com')
  with check (auth.email() = 'keefefons@gmail.com');

-- =================================================================
-- 5. dismiss_report - now resolves in place instead of deleting
-- =================================================================
-- Signature changes (adds an optional note), so the old single-arg version
-- has to be dropped first or Postgres would keep both as an overload.
drop function if exists public.dismiss_report(uuid);

create or replace function public.dismiss_report(report_id uuid, note text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
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
-- 6. warn_user - now optionally resolves the report it came from
-- =================================================================
-- Signature changes (adds report_id + details), so drop the old 2-arg
-- version first, same reasoning as above.
drop function if exists public.warn_user(uuid, text);

create or replace function public.warn_user(target_id uuid, message text, report_id uuid default null, details text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  new_warning_id uuid;
  effective_details text := details;
begin
  if auth.email() <> 'keefefons@gmail.com' then
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
-- 7 + 8. mark a single message "read in the list" (drives the unread badge)
-- =================================================================
create or replace function public.mark_warning_read(warning_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.warnings set read_at = now()
    where id = warning_id and user_id = auth.uid() and read_at is null;
end;
$$;
revoke all on function public.mark_warning_read(uuid) from public, anon;
grant execute on function public.mark_warning_read(uuid) to authenticated;

create or replace function public.mark_system_notification_read(notif_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.system_notifications set read_at = now()
    where id = notif_id and user_id = auth.uid() and read_at is null;
end;
$$;
revoke all on function public.mark_system_notification_read(uuid) from public, anon;
grant execute on function public.mark_system_notification_read(uuid) to authenticated;

-- =================================================================
-- 9 + 10. admin composes a System Notification
-- =================================================================
create or replace function public.send_system_notification(target_ids uuid[], title text, body text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  if coalesce(btrim(title), '') = '' or coalesce(btrim(body), '') = '' then
    raise exception 'Title and message cannot be empty';
  end if;
  insert into public.system_notifications (user_id, title, body)
  select unnest(target_ids), title, body;
end;
$$;
revoke all on function public.send_system_notification(uuid[], text, text) from public, anon;
grant execute on function public.send_system_notification(uuid[], text, text) to authenticated;

create or replace function public.broadcast_system_notification(title text, body text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  if coalesce(btrim(title), '') = '' or coalesce(btrim(body), '') = '' then
    raise exception 'Title and message cannot be empty';
  end if;
  -- Fan-out: one row per user, so each person gets their own independent
  -- read-state instead of a shared row + separate read-receipts table.
  insert into public.system_notifications (user_id, title, body)
  select id, title, body from public.profiles;
end;
$$;
revoke all on function public.broadcast_system_notification(text, text) from public, anon;
grant execute on function public.broadcast_system_notification(text, text) to authenticated;

-- =================================================================
-- 11. mark_blocks_seen - clears the dashboard's "new blocks" count
-- =================================================================
create or replace function public.mark_blocks_seen()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
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
-- Realtime: push system_notifications inserts to the recipient live
-- (mirrors migration_realtime.sql's pattern for noots/coin_gifts). RLS still
-- applies, so each client only receives rows where it is the recipient.
-- =================================================================
alter publication supabase_realtime add table public.system_notifications;
