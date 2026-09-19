-- 員工角色調整：正式只使用 admin／purchaser／housekeeper，viewer 停用但保留enum值。
-- 請在Supabase SQL Editor執行，需先執行過 schema.sql 及 0001~0004 四支migration。
-- 不會刪除 staff_role enum 中的 viewer 值（避免高風險的enum重建操作）、不會刪除任何員工資料，
-- 也不會把既有viewer帳號自動轉成其他角色。

-- ===== 1. 既有viewer帳號先停用，角色不自動轉換，交由管理員重新指定 =====
update public.staff_profiles set active = false where role = 'viewer' and active = true;

-- ===== 2. 新建員工不再預設viewer，必須由管理員明確指定角色 =====
alter table public.staff_profiles alter column role drop default;

-- ===== 3. 擋下任何「新建或改成viewer」的寫入；已經是viewer的舊資料不受影響，只擋新的指派 =====
create or replace function public.enforce_no_viewer_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'viewer' and (tg_op = 'INSERT' or old.role is distinct from 'viewer') then
    raise exception 'viewer role can no longer be assigned';
  end if;
  return new;
end;
$$;

drop trigger if exists staff_profiles_no_viewer_guard on public.staff_profiles;
create trigger staff_profiles_no_viewer_guard
  before insert or update on public.staff_profiles
  for each row
  execute function public.enforce_no_viewer_role();

-- ===== 4. 邀請員工：僅admin可呼叫。因為不使用service role金鑰，無法透過API直接建立auth帳號，
--    所以只能邀請「已經至少成功登入過一次」（auth.users已有紀錄）的Email，並由admin明確指定角色。
--    找不到帳號時明確報錯，不會生出新的auth使用者，也不會給任何隱含預設角色。
create or replace function public.invite_staff_member(p_email text, p_display_name text, p_role public.staff_role)
returns public.staff_profiles
language plpgsql security definer set search_path = public, auth as $$
declare
  target_user_id uuid;
  result_row public.staff_profiles;
begin
  if not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;
  if p_role = 'viewer' then
    raise exception 'viewer role can no longer be assigned';
  end if;
  if p_email is null or length(trim(p_email)) = 0 then
    raise exception 'email is required';
  end if;

  select id into target_user_id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if target_user_id is null then
    raise exception 'auth user not found for email' using errcode = 'P0002';
  end if;

  insert into public.staff_profiles (id, display_name, email, role, active)
  values (target_user_id, coalesce(nullif(trim(p_display_name), ''), lower(trim(p_email))), lower(trim(p_email)), p_role, true)
  on conflict (id) do update set
    display_name = coalesce(nullif(trim(excluded.display_name), ''), public.staff_profiles.display_name),
    role = excluded.role,
    active = true
  returning * into result_row;

  return result_row;
end;
$$;

revoke all on function public.invite_staff_member(text, text, public.staff_role) from public;
grant execute on function public.invite_staff_member(text, text, public.staff_role) to authenticated;
