-- Chef Penguino: undo an accidental "Mark Resolved" — moves a report back to
-- open. Run once in the Supabase SQL Editor, after migration_bug_resolve.sql.

create or replace function public.unresolve_bug_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set status = 'open' where id = report_id;
end;
$$;
