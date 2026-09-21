-- 讓採購需求、交接留言、進貨單、進貨單保存天數設定改存Supabase，所有登入員工看到同一份資料。
-- purchase_requests／handover_notes／receipts三張表在schema.sql早就建立，這支只補「共用設定表」與缺少的RLS政策。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0012所有migration。可重複執行。

-- ===== 1. 共用系統設定（目前只有進貨單照片保存天數） =====
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.staff_profiles(id),
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "active staff read app settings" on public.app_settings;
create policy "active staff read app settings" on public.app_settings
  for select using (public.is_active_staff());

drop policy if exists "admins write app settings" on public.app_settings;
drop policy if exists "admins purchasers write app settings" on public.app_settings;
create policy "admins purchasers write app settings" on public.app_settings
  for all
  using (public.has_role(array['admin','purchaser']::public.staff_role[]))
  with check (public.has_role(array['admin','purchaser']::public.staff_role[]));

insert into public.app_settings (key, value)
values ('receipt_retention_days', '90'::jsonb)
on conflict (key) do nothing;

-- ===== 2. 交接留言：目前只有新增與修改政策，補上「僅管理員可刪除」 =====
drop policy if exists "admins delete notes" on public.handover_notes;
create policy "admins delete notes" on public.handover_notes
  for delete using (public.has_role(array['admin']::public.staff_role[]));

-- ===== 3. 查詢用索引 =====
create index if not exists purchase_requests_created_at_idx on public.purchase_requests (created_at desc);
create index if not exists handover_notes_created_at_idx on public.handover_notes (created_at desc);
create index if not exists receipts_created_at_idx on public.receipts (created_at desc);
