-- Chef Penguino: undo a dismissal — moves a dismissed report back to open.
-- Dismissed used to be a one-way door: the Manage menu only ever offered
-- "Dismiss", so an accidental dismissal could not be walked back. Run once in
-- the Supabase SQL Editor, after migration_bug_dismiss.sql.

create or replace function public.undismiss_bug_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  -- `is distinct from` (not `<>`): a null auth.email() must fail closed.
  if auth.email() is distinct from 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  update public.bug_reports set status = 'open' where id = report_id;
end;
$$;

grant execute on function public.undismiss_bug_report(uuid) to authenticated;
