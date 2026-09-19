-- 品項分類管理：讓「品項大分類」可由管理員維護，不再寫死在程式碼。
-- 請在Supabase SQL Editor執行，需先執行過 supabase/schema.sql。

alter table public.inventory_categories
  alter column created_by drop not null,
  add column if not exists sort_order integer not null default 0,
  add column if not exists active boolean not null default true;

-- 寫入原本寫死在程式碼裡的6個預設分類，已存在則略過。
insert into public.inventory_categories (name, sort_order, active)
values
  ('客房備品', 1, true),
  ('清潔用品', 2, true),
  ('早餐食材', 3, true),
  ('晚餐食材', 4, true),
  ('廚房用品', 5, true),
  ('維修耗材', 6, true)
on conflict (name) do nothing;

-- 分類的新增／修改／刪除限管理員操作；伺服器端API一律以登入者自己的session執行，同樣受此RLS政策約束。
drop policy if exists "inventory managers manage categories" on public.inventory_categories;

create policy "admins manage categories" on public.inventory_categories
  for all
  using (public.has_role(array['admin']::public.staff_role[]))
  with check (public.has_role(array['admin']::public.staff_role[]));
