-- Chef Penguino: dismiss a bug report without replying (closes it out of the
-- admin queue). Run once in the Supabase SQL Editor, after
-- migration_bug_reports.sql.

create or replace function public.dismiss_bug_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set status = 'dismissed' where id = report_id;
end;
$$;
