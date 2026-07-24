-- Chef Penguino: allow signed-out GUESTS to submit bug reports. Run once in
-- the Supabase SQL Editor, after migration_bug_reports.sql / _claude.sql.
--
-- A guest report has reporter_id = NULL. Guests get no acknowledgement
-- notification (no mailbox) and can't be replied to; admin can still read,
-- resolve, and dismiss them. Screenshots go to a shared 'guest/' storage
-- folder.

alter table public.bug_reports alter column reporter_id drop not null;

-- Accept anonymous submissions (reporter_id = auth.uid(), NULL for guests).
create or replace function public.submit_bug_report(description text, screenshot_url text default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_report_id uuid;
begin
  insert into public.bug_reports (reporter_id, description, screenshot_url)
    values (auth.uid(), description, screenshot_url)
    returning id into new_report_id;

  -- Only signed-in reporters have a mailbox to acknowledge into.
  if auth.uid() is not null then
    insert into public.system_notifications (user_id, title, body)
      values (auth.uid(), 'Bug report received', 'We got your bug report — thanks! We''ll take a look. 🐧');
  end if;

  return new_report_id;
end;
$$;

-- Queue read: LEFT JOIN so guest (NULL reporter) rows still appear, labelled 'Guest'.
create or replace function public.claude_bug_queue(token text)
returns table (
  id uuid,
  description text,
  screenshot_url text,
  status text,
  admin_reply text,
  reporter_name text,
  created_at timestamptz,
  sent_to_claude_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if token <> 'a7f3c9e1-4b2d-4e8a-9c6f-1d2e3f4a5b6c' then
    raise exception 'Not authorised';
  end if;
  return query
    select b.id, b.description, b.screenshot_url, b.status, b.admin_reply,
           coalesce(p.display_name, 'Guest'), b.created_at, b.sent_to_claude_at
    from public.bug_reports b
    left join public.profiles p on p.id = b.reporter_id
    where b.sent_to_claude_at is not null
    order by b.sent_to_claude_at desc;
end;
$$;

-- Let anonymous guests upload screenshots into the shared 'guest/' folder.
create policy "guests can upload bug screenshots"
  on storage.objects for insert
  with check (bucket_id = 'bug-shots' and (storage.foldername(name))[1] = 'guest');
