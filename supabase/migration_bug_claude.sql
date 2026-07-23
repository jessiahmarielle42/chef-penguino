-- Chef Penguino: "Send to Claude" — the admin flags a bug report so Claude can
-- read it (screenshot + text) and plan a fix. Run once in the Supabase SQL
-- Editor, after migration_bug_reports.sql.

alter table public.bug_reports add column if not exists sent_to_claude_at timestamptz;

-- ---------- admin flags a report for Claude ----------
create or replace function public.flag_bug_report_for_claude(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set sent_to_claude_at = now() where id = report_id;
end;
$$;

-- ---------- Claude reads the flagged queue ----------
-- Returns ONLY the reports the admin has explicitly flagged, and only when the
-- caller passes the shared secret. This keeps the public anon key alone from
-- being able to dump report contents (the secret lives in this private repo,
-- not in the shipped client bundle).
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
           p.display_name, b.created_at, b.sent_to_claude_at
    from public.bug_reports b
    join public.profiles p on p.id = b.reporter_id
    where b.sent_to_claude_at is not null
    order by b.sent_to_claude_at desc;
end;
$$;
