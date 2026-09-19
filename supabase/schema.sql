-- 茶香花園民宿內部採購與庫存系統
-- 請在Supabase SQL Editor執行。上線前先以測試帳號驗證RLS。

create extension if not exists pgcrypto;

create type public.staff_role as enum ('admin', 'purchaser', 'housekeeper', 'viewer');
create type public.purchase_status as enum ('pending', 'approved', 'ordered', 'arrived', 'stocked', 'paused');
create type public.movement_type as enum ('purchase_in', 'daily_use', 'room_supply', 'food_use', 'damaged', 'expired', 'adjustment');

create table public.staff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null unique,
  role public.staff_role not null default 'viewer',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null,
  storage_location text not null,
  base_unit text not null,
  quantity numeric(12,2) not null default 0 check (quantity >= 0),
  safety_stock numeric(12,2) not null default 0 check (safety_stock >= 0),
  suggested_purchase numeric(12,2) not null default 0 check (suggested_purchase >= 0),
  supplier text,
  nearest_expiry_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid references public.inventory_items(id),
  item_name text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit text not null,
  priority text not null default 'normal' check (priority in ('normal','urgent')),
  status public.purchase_status not null default 'pending',
  note text,
  requester_id uuid not null references public.staff_profiles(id),
  approved_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id),
  movement_type public.movement_type not null,
  quantity_change numeric(12,2) not null check (quantity_change <> 0),
  unit text not null,
  note text,
  operator_id uuid not null references public.staff_profiles(id),
  created_at timestamptz not null default now()
);

create table public.handover_notes (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  content text not null check (char_length(content) between 1 and 2000),
  important boolean not null default false,
  author_id uuid not null references public.staff_profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 50),
  created_by uuid not null references public.staff_profiles(id),
  created_at timestamptz not null default now()
);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  supplier text,
  purchase_date date,
  invoice_number text,
  total_amount numeric(12,2),
  original_file_name text not null,
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending','stocked','failed')),
  warnings jsonb not null default '[]'::jsonb,
  uploaded_by uuid not null references public.staff_profiles(id),
  delete_after timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now()
);

create table public.receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id),
  item_name text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit text not null,
  unit_price numeric(12,2),
  total_price numeric(12,2),
  category text,
  created_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false;

alter table public.staff_profiles enable row level security;
alter table public.inventory_items enable row level security;
alter table public.purchase_requests enable row level security;
alter table public.stock_movements enable row level security;
alter table public.handover_notes enable row level security;
alter table public.inventory_categories enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_lines enable row level security;

create or replace function public.is_active_staff()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.staff_profiles p where p.id = auth.uid() and p.active); $$;

create or replace function public.has_role(allowed public.staff_role[])
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.staff_profiles p where p.id = auth.uid() and p.active and p.role = any(allowed)); $$;

create policy "active staff read profiles" on public.staff_profiles for select using (public.is_active_staff());
create policy "admins manage profiles" on public.staff_profiles for all using (public.has_role(array['admin']::public.staff_role[])) with check (public.has_role(array['admin']::public.staff_role[]));
create policy "active staff read inventory" on public.inventory_items for select using (public.is_active_staff());
create policy "inventory managers write inventory" on public.inventory_items for all using (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[])) with check (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]));
create policy "active staff read purchases" on public.purchase_requests for select using (public.is_active_staff());
create policy "staff create purchases" on public.purchase_requests for insert with check (public.is_active_staff() and requester_id = auth.uid());
create policy "purchasers update purchases" on public.purchase_requests for update using (public.has_role(array['admin','purchaser']::public.staff_role[]));
create policy "active staff read movements" on public.stock_movements for select using (public.is_active_staff());
create policy "staff create movements" on public.stock_movements for insert with check (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) and operator_id = auth.uid());
create policy "active staff read notes" on public.handover_notes for select using (public.is_active_staff());
create policy "staff create notes" on public.handover_notes for insert with check (public.is_active_staff() and author_id = auth.uid());
create policy "authors or admins update notes" on public.handover_notes for update using (author_id = auth.uid() or public.has_role(array['admin']::public.staff_role[]));
create policy "active staff read categories" on public.inventory_categories for select using (public.is_active_staff());
create policy "inventory managers manage categories" on public.inventory_categories for all using (public.has_role(array['admin','purchaser']::public.staff_role[])) with check (public.has_role(array['admin','purchaser']::public.staff_role[]) and created_by = auth.uid());
create policy "active staff read receipts" on public.receipts for select using (public.is_active_staff());
create policy "staff create receipts" on public.receipts for insert with check (public.is_active_staff() and uploaded_by = auth.uid());
create policy "inventory managers update receipts" on public.receipts for update using (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]));
create policy "active staff read receipt lines" on public.receipt_lines for select using (public.is_active_staff());
create policy "inventory managers manage receipt lines" on public.receipt_lines for all using (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[])) with check (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]));

create policy "staff view private receipt images" on storage.objects for select to authenticated
using (bucket_id = 'receipts' and public.is_active_staff());
create policy "staff upload private receipt images" on storage.objects for insert to authenticated
with check (bucket_id = 'receipts' and public.is_active_staff() and (storage.foldername(name))[1] = auth.uid()::text);
create policy "admins delete private receipt images" on storage.objects for delete to authenticated
using (bucket_id = 'receipts' and public.has_role(array['admin','purchaser']::public.staff_role[]));

-- 以交易函式更新庫存，避免前端直接改寫數量造成紀錄不一致。
create or replace function public.record_stock_movement(
  target_item uuid, movement public.movement_type, change_amount numeric, movement_note text default null
) returns public.stock_movements language plpgsql security definer set search_path = public as $$
declare new_movement public.stock_movements;
begin
  if not public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) then raise exception 'not authorized'; end if;
  if change_amount = 0 then raise exception 'quantity change cannot be zero'; end if;
  update public.inventory_items set quantity = quantity + change_amount, updated_at = now()
  where id = target_item and quantity + change_amount >= 0;
  if not found then raise exception 'item missing or insufficient stock'; end if;
  insert into public.stock_movements(inventory_item_id,movement_type,quantity_change,unit,note,operator_id)
  select id,movement,change_amount,base_unit,movement_note,auth.uid() from public.inventory_items where id=target_item returning * into new_movement;
  return new_movement;
end; $$;

revoke all on function public.record_stock_movement(uuid, public.movement_type, numeric, text) from public;
grant execute on function public.record_stock_movement(uuid, public.movement_type, numeric, text) to authenticated;

-- 每日排程可查詢此函式取得應刪除照片，再由Edge Function透過Storage API刪除檔案與資料。
create or replace function public.expired_receipt_paths()
returns table(receipt_id uuid, storage_path text)
language sql security definer set search_path = public
as $$
  select id, receipts.storage_path from public.receipts
  where delete_after <= now() and storage_path is not null;
$$;
revoke all on function public.expired_receipt_paths() from public;
grant execute on function public.expired_receipt_paths() to service_role;
