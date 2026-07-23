-- Chef Penguino: bug reports (user submits, admin replies)
-- Run once in the Supabase SQL Editor, after schema.sql (profiles) and
-- migration_system_notifications.sql (system_notifications).
--
-- Acknowledgements and admin replies are delivered by inserting rows into
-- the existing public.system_notifications table - no new "kind" column,
-- no separate mailbox table.

-- ---------- bug_reports ----------
create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  description text not null,
  screenshot_url text,
  status text not null default 'open',
  admin_reply text,
  created_at timestamptz not null default now(),
  replied_at timestamptz
);

alter table public.bug_reports enable row level security;

create policy "users can see their own bug reports"
  on public.bug_reports for select
  using (reporter_id = auth.uid());

create policy "admin can view all bug reports"
  on public.bug_reports for select
  using (auth.email() = 'keefefons@gmail.com');

-- No insert/update/delete policies - all writes go through the
-- security-definer functions below, same pattern as blocked_users/reports.

-- ---------- submit a bug report ----------
create or replace function public.submit_bug_report(description text, screenshot_url text default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_report_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  insert into public.bug_reports (reporter_id, description, screenshot_url)
    values (auth.uid(), description, screenshot_url)
    returning id into new_report_id;

  insert into public.system_notifications (user_id, title, body)
    values (auth.uid(), 'Bug report received', 'We got your bug report — thanks! We''ll take a look. 🐧');

  return new_report_id;
end;
$$;

-- ---------- admin replies to a bug report ----------
create or replace function public.reply_bug_report(report_id uuid, message text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_reporter_id uuid;
begin
  if auth.email() <> 'keefefons@gmail.com' then
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

-- ---------- storage: bug screenshots ----------
-- Public read bucket - screenshots are only ever linked from a report the
-- admin can see, so there's no sensitive-data reason to gate reads.
insert into storage.buckets (id, name, public) values ('bug-shots', 'bug-shots', true)
  on conflict (id) do nothing;

create policy "users can upload their own bug screenshots"
  on storage.objects for insert
  with check (
    bucket_id = 'bug-shots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "anyone can view bug screenshots"
  on storage.objects for select
  using (bucket_id = 'bug-shots');
