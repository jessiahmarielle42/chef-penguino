-- Chef Penguino: bug-report "Mark Resolved" + "Unsend from Claude" admin
-- actions. Run once in the Supabase SQL Editor, after migration_bug_reports.sql
-- and migration_bug_claude.sql.

-- ---------- mark a report resolved ----------
create or replace function public.resolve_bug_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set status = 'resolved' where id = report_id;
end;
$$;

-- ---------- unsend a report from Claude's queue (clears the flag) ----------
create or replace function public.unflag_bug_report_for_claude(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set sent_to_claude_at = null where id = report_id;
end;
$$;
