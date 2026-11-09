-- 品項分類：改名連動、一次排序
-- 問題 1：庫存品項（inventory_items.category）和進貨明細（receipt_lines.category）存的是分類的「名稱文字」，
--         原本改名只改了 inventory_categories 那一列，所有品項與歷史進貨還掛著舊名稱，資料就對不上了
--         （分類清單顯示尚未被使用、進貨報表分成新舊兩條、庫存的分類篩選找不到它們）。
-- 問題 2：排序是前端送兩個請求互相交換，不是一次完成，中間失敗或有人同時操作會出現兩個分類順序相同。
-- 做法：兩個管理員專用的資料庫函式，各自在單一交易內完成。
-- 在 Supabase SQL Editor 執行；可重複執行。不會修改任何現有資料（只新增函式）。

-- ===== 1. 改名：分類、庫存品項、進貨明細一起改 =====
create or replace function public.rename_inventory_category(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_name text;
  new_name text := btrim(coalesce(p_name, ''));
begin
  if not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admins can rename categories' using errcode = '42501';
  end if;
  if new_name = '' or char_length(new_name) > 50 then
    raise exception 'invalid category name' using errcode = '22023';
  end if;

  select name into old_name from public.inventory_categories where id = p_id for update;
  if not found then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
  if old_name = new_name then
    return;
  end if;
  if exists (select 1 from public.inventory_categories where name = new_name and id <> p_id) then
    raise exception 'duplicate category name' using errcode = '23505';
  end if;

  update public.inventory_categories set name = new_name where id = p_id;
  update public.inventory_items set category = new_name where category = old_name;
  update public.receipt_lines set category = new_name where category = old_name;
end;
$$;

revoke all on function public.rename_inventory_category(uuid, text) from public;
grant execute on function public.rename_inventory_category(uuid, text) to authenticated;

-- ===== 2. 排序：一次給完整順序，整批更新 =====
-- p_ids 必須剛好是目前「所有」分類的 id（不多不少、不重複）。如果期間有人新增或刪除了分類，
-- 數量對不上就拒絕（錯誤碼 P0011），畫面會請使用者重新載入，不會悄悄排成錯的順序。
create or replace function public.reorder_inventory_categories(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
begin
  if not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admins can reorder categories' using errcode = '42501';
  end if;

  -- 驗證到更新完成之前，擋住其他人同時新增／刪除／修改分類，確認過的「所有分類」才不會中途變動。
  lock table public.inventory_categories in share row exclusive mode;

  select count(*) into total from public.inventory_categories;
  if coalesce(array_length(p_ids, 1), 0) <> total
     or (select count(distinct x) from unnest(p_ids) as x) <> total
     or exists (select 1 from unnest(p_ids) as x where not exists (select 1 from public.inventory_categories c where c.id = x)) then
    raise exception 'category list is out of date' using errcode = 'P0011';
  end if;

  update public.inventory_categories c
     set sort_order = t.ord
    from unnest(p_ids) with ordinality as t(id, ord)
   where c.id = t.id;
end;
$$;

revoke all on function public.reorder_inventory_categories(uuid[]) from public;
grant execute on function public.reorder_inventory_categories(uuid[]) to authenticated;
