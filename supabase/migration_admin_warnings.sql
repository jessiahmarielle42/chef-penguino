-- Chef Penguino: admin can dismiss reports and warn reported users.
-- Run once in the Supabase SQL Editor (after migration_block_report.sql).

-- ---------- dismiss (delete) a report: admin only ----------
create or replace function public.dismiss_report(report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  delete from public.reports where id = report_id;
end;
$$;
revoke all on function public.dismiss_report(uuid) from public, anon;
grant execute on function public.dismiss_report(uuid) to authenticated;

-- ---------- warnings ----------
-- A warning is a message the admin sends to a user. The user sees it as a
-- popup next time the app loads (like a Noot), then acknowledges it.
create table public.warnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

alter table public.warnings enable row level security;

create policy "users can see their own warnings"
  on public.warnings for select
  using (user_id = auth.uid());

create policy "admin can view all warnings"
  on public.warnings for select
  using (auth.email() = 'keefefons@gmail.com');

-- No direct insert/update policies - both go through the security-definer
-- functions below (admin-only send; owner-only acknowledge).

-- ---------- admin sends a warning ----------
create or replace function public.warn_user(target_id uuid, message text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.email() <> 'keefefons@gmail.com' then
    raise exception 'Not authorised';
  end if;
  if coalesce(btrim(message), '') = '' then
    raise exception 'Warning message cannot be empty';
  end if;
  insert into public.warnings (user_id, message) values (target_id, message);
end;
$$;
revoke all on function public.warn_user(uuid, text) from public, anon;
grant execute on function public.warn_user(uuid, text) to authenticated;

-- ---------- user acknowledges their own warning ----------
create or replace function public.acknowledge_warning(warning_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.warnings set acknowledged_at = now()
    where id = warning_id and user_id = auth.uid();
end;
$$;
revoke all on function public.acknowledge_warning(uuid) from public, anon;
grant execute on function public.acknowledge_warning(uuid) to authenticated;
