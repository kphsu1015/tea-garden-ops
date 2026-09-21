-- Email＋密碼登入：新增「員工邀請」資料表與接受邀請的RPC，讓管理員可以在對方從未登入過的情況下
-- 先建立白名單（Email＋角色），系統寄送一次性設定密碼連結；對方點擊連結完成Supabase官方驗證後，
-- 才會正式建立 staff_profiles（因為它的id必須參照真實存在的auth.users，這裡不繞過、也不使用service role金鑰）。
-- 請在Supabase SQL Editor執行，需先執行過 schema.sql 及 0001~0006 六支migration。
-- 不會修改既有資料表欄位、不會刪除任何資料、staff_profiles不會新增password欄位（密碼只由Supabase Auth保存）。

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  role public.staff_role not null check (role <> 'viewer'),
  invited_by uuid not null references public.staff_profiles(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.staff_invitations enable row level security;

create policy "admins manage staff invitations" on public.staff_invitations
  for all
  using (public.has_role(array['admin']::public.staff_role[]))
  with check (public.has_role(array['admin']::public.staff_role[]));

-- 新登入的使用者（尚未是staff_profiles）呼叫這支，把自己符合的待處理邀請兌換成正式員工身分。
-- 只認自己Email（auth.uid()對應的auth.users.email）符合的邀請，不能替別人兌換。
create or replace function public.accept_staff_invitation()
returns public.staff_profiles
language plpgsql security definer set search_path = public, auth as $$
declare
  invitation public.staff_invitations;
  result_row public.staff_profiles;
  current_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'P0001';
  end if;

  select email into current_email from auth.users where id = auth.uid();
  if current_email is null then
    raise exception 'auth user not found' using errcode = 'P0001';
  end if;

  select * into invitation from public.staff_invitations
  where lower(email) = lower(current_email) and accepted_at is null
  limit 1;

  if invitation.id is null then
    raise exception 'no pending invitation for this email' using errcode = 'P0002';
  end if;

  insert into public.staff_profiles (id, display_name, email, role, active)
  values (auth.uid(), coalesce(nullif(trim(invitation.display_name), ''), current_email), current_email, invitation.role, true)
  on conflict (id) do update set
    role = excluded.role,
    active = true,
    display_name = coalesce(nullif(trim(excluded.display_name), ''), public.staff_profiles.display_name)
  returning * into result_row;

  update public.staff_invitations set accepted_at = now() where id = invitation.id;

  return result_row;
end;
$$;

revoke all on function public.accept_staff_invitation() from public;
grant execute on function public.accept_staff_invitation() to authenticated;
