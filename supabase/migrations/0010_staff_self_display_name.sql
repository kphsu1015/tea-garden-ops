-- 讓已登入員工可以自己修改暱稱（display_name），不管角色是admin／purchaser／housekeeper都可以。
-- staff_profiles目前的RLS政策（0004之前，schema.sql）「admins manage profiles」只允許admin寫入這張表，
-- 一般員工完全不能修改自己的任何欄位（包含暱稱）。這裡不修改RLS政策，改用SECURITY DEFINER RPC，
-- 函式內部只用auth.uid()鎖定「只能改自己那一列的display_name」，不會影響其他員工資料，也不會動到role／active／email。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0009所有migration。

create or replace function public.update_own_display_name(p_display_name text)
returns public.staff_profiles
language plpgsql security definer set search_path = public as $$
declare
  updated public.staff_profiles;
  new_name text := nullif(trim(p_display_name), '');
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'P0001';
  end if;
  if new_name is null then
    raise exception 'display name is required' using errcode = 'P0001';
  end if;
  if char_length(new_name) > 50 then
    raise exception 'display name must be 50 characters or fewer' using errcode = 'P0001';
  end if;

  update public.staff_profiles set display_name = new_name where id = auth.uid()
  returning * into updated;

  if not found then
    raise exception 'staff profile not found' using errcode = 'P0002';
  end if;

  return updated;
end;
$$;

revoke all on function public.update_own_display_name(text) from public;
grant execute on function public.update_own_display_name(text) to authenticated;
