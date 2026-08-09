-- Second admin: jessiahmarielle@gmail.com
-- Run once in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- WHY THIS IS WRITTEN AS A LOOP, NOT 65 HAND-EDITED STATEMENTS:
-- 'keefefons@gmail.com' is hardcoded in ~65 places across 20 migration files
-- (RLS policies + SECURITY DEFINER functions). Transcribing all of those by
-- hand risks missing one - and a missed RLS policy is a silent privilege bug,
-- not a visible error. So this reads the CURRENT database catalog, finds every
-- gate that mentions the literal, and rewrites it to call one helper. It adapts
-- to whatever is actually live, which may differ from the .sql files on disk.
--
-- After this, adding or removing an admin = editing is_app_admin() ONLY.

-- 1. The single source of truth for "is this caller an admin".
--    NOT security definer: it only reads the caller's own JWT claim.
create or replace function public.is_app_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.email() in (
    'keefefons@gmail.com',
    'jessiahmarielle@gmail.com'
  ), false)
$$;

grant execute on function public.is_app_admin() to authenticated, anon;

-- 2. Rewrite every RLS policy whose USING / WITH CHECK mentions the literal.
do $$
declare
  r record;
  new_qual text;
  new_check text;
  sql text;
  n_pol int := 0;
begin
  for r in
    select pol.polname,
           cls.relname,
           nsp.nspname,
           pg_get_expr(pol.polqual, pol.polrelid)      as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as wcheck
    from pg_policy pol
    join pg_class cls on cls.oid = pol.polrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
  loop
    if coalesce(r.qual, '') not like '%keefefons@gmail.com%'
       and coalesce(r.wcheck, '') not like '%keefefons@gmail.com%' then
      continue;
    end if;

    -- Both the rendered form (with ::text) and the bare form.
    new_qual := replace(replace(coalesce(r.qual, ''),
      '(auth.email() = ''keefefons@gmail.com''::text)', 'public.is_app_admin()'),
      'auth.email() = ''keefefons@gmail.com''::text', 'public.is_app_admin()');
    new_check := replace(replace(coalesce(r.wcheck, ''),
      '(auth.email() = ''keefefons@gmail.com''::text)', 'public.is_app_admin()'),
      'auth.email() = ''keefefons@gmail.com''::text', 'public.is_app_admin()');

    sql := format('alter policy %I on %I.%I', r.polname, r.nspname, r.relname);
    if r.qual is not null then sql := sql || format(' using (%s)', new_qual); end if;
    if r.wcheck is not null then sql := sql || format(' with check (%s)', new_check); end if;

    begin
      execute sql;
      n_pol := n_pol + 1;
      raise notice 'rewrote policy %.% / %', r.nspname, r.relname, r.polname;
    exception when others then
      -- storage.objects policies are owned by supabase_storage_admin and may
      -- refuse ALTER here; reported rather than silently skipped.
      raise warning 'COULD NOT rewrite policy %.% / %: %', r.nspname, r.relname, r.polname, sqlerrm;
    end;
  end loop;
  raise notice 'policies rewritten: %', n_pol;
end $$;

-- 3. Rewrite every function body that gates on the literal.
do $$
declare
  r record;
  src text;
  n_fn int := 0;
begin
  for r in
    select p.oid, n.nspname, p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'storage')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%keefefons@gmail.com%'
  loop
    src := r.def;
    -- "not admin" guards: `if auth.email() is distinct from '...' then raise`
    src := replace(src, 'auth.email() is distinct from ''keefefons@gmail.com''', 'not public.is_app_admin()');
    src := replace(src, 'auth.email() <> ''keefefons@gmail.com''', 'not public.is_app_admin()');
    src := replace(src, 'auth.email() != ''keefefons@gmail.com''', 'not public.is_app_admin()');
    -- "is admin" checks
    src := replace(src, 'auth.email() = ''keefefons@gmail.com''::text', 'public.is_app_admin()');
    src := replace(src, 'auth.email() = ''keefefons@gmail.com''', 'public.is_app_admin()');
    src := replace(src, 'auth.email() is not distinct from ''keefefons@gmail.com''', 'public.is_app_admin()');

    if src like '%keefefons@gmail.com%' then
      raise warning 'function %.% still contains the literal after rewrite - REVIEW IT MANUALLY', r.nspname, r.proname;
    end if;

    begin
      execute src;
      n_fn := n_fn + 1;
      raise notice 'rewrote function %.%', r.nspname, r.proname;
    exception when others then
      raise warning 'COULD NOT rewrite function %.%: %', r.nspname, r.proname, sqlerrm;
    end;
  end loop;
  raise notice 'functions rewritten: %', n_fn;
end $$;

-- 4. VERIFY - both queries should return ZERO rows when this worked.
--    Anything listed here is still admin-gated to keefefons only.
select 'policy' as kind, nsp.nspname || '.' || cls.relname as obj, pol.polname as name
from pg_policy pol
join pg_class cls on cls.oid = pol.polrelid
join pg_namespace nsp on nsp.oid = cls.relnamespace
where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%keefefons@gmail.com%'
   or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') like '%keefefons@gmail.com%'
union all
select 'function', n.nspname || '.' || p.proname, p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'storage')
  and p.prokind = 'f'
  and pg_get_functiondef(p.oid) like '%keefefons@gmail.com%';

-- 5. Sanity check the helper itself (run while signed in as each admin):
--    select auth.email(), public.is_app_admin();
