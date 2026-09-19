-- 進貨金額報表：新增彙總用RPC、金額非負約束，以及「僅admin可修改已入庫進貨單金額」的防呆trigger。
-- 請在Supabase SQL Editor執行，需先執行過 schema.sql、0001~0003 三支migration。
-- 不會建立新資料表、不會修改既有欄位型別、不會刪除既有資料。

-- ===== 1. 金額欄位不得為負數 =====
alter table public.receipts
  add constraint receipts_total_amount_nonnegative check (total_amount is null or total_amount >= 0);

alter table public.receipt_lines
  add constraint receipt_lines_unit_price_nonnegative check (unit_price is null or unit_price >= 0),
  add constraint receipt_lines_total_price_nonnegative check (total_price is null or total_price >= 0);

-- ===== 2. 僅admin可修改已入庫進貨單／品項的金額欄位 =====
-- 既有的UPDATE政策（admin/purchaser/housekeeper）用來處理狀態、警示訊息等一般欄位，這裡另外用trigger
-- 針對「金額」欄位加一層限制，不影響原本政策涵蓋的其他操作。
create or replace function public.enforce_receipt_amount_edit_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.total_amount is distinct from old.total_amount) and not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admin can modify receipt total amount';
  end if;
  return new;
end;
$$;

drop trigger if exists receipts_amount_edit_guard on public.receipts;
create trigger receipts_amount_edit_guard
  before update on public.receipts
  for each row
  execute function public.enforce_receipt_amount_edit_role();

create or replace function public.enforce_receipt_line_amount_edit_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.unit_price is distinct from old.unit_price or new.total_price is distinct from old.total_price)
     and not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admin can modify receipt line amount';
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_lines_amount_edit_guard on public.receipt_lines;
create trigger receipt_lines_amount_edit_guard
  before update on public.receipt_lines
  for each row
  execute function public.enforce_receipt_line_amount_edit_role();

-- ===== 3. 刪除／取消已入庫進貨單：僅admin，且receipt_lines需要對應的DELETE政策讓cascade正常運作 =====
create policy "admin delete receipts" on public.receipts
  for delete
  using (public.has_role(array['admin']::public.staff_role[]));

create policy "admin delete receipt lines" on public.receipt_lines
  for delete
  using (public.has_role(array['admin']::public.staff_role[]));

-- ===== 4. 查詢效能索引 =====
create index if not exists receipts_status_purchase_date_idx on public.receipts (status, purchase_date);
create index if not exists receipt_lines_receipt_id_idx on public.receipt_lines (receipt_id);

-- ===== 5. 報表彙總RPC =====
-- 全部限admin／purchaser呼叫（housekeeper可以新增進貨資料，但看不到整體營運金額報表；viewer完全看不到）。
-- 全部以security invoker執行，內部查詢仍受receipts／receipt_lines既有RLS約束（is_active_staff()），
-- 這裡的角色檢查是在那之上再收斂到admin／purchaser。

create or replace function public.get_purchase_monthly_summary(p_month date)
returns table (
  total_amount numeric,
  receipt_count integer,
  item_count integer,
  top_category_name text,
  top_category_amount numeric,
  top_supplier_name text,
  top_supplier_amount numeric,
  prev_month_total_amount numeric
)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  prev_month_start date := (date_trunc('month', p_month) - interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  with receipt_effective as (
    select r.id,
      coalesce(r.total_amount, (select sum(rl.total_price) from public.receipt_lines rl where rl.receipt_id = r.id)) as effective_amount
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
  ),
  category_totals as (
    select coalesce(rl.category, ii.category, '未分類') as category,
      sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)) as amount
    from public.receipt_lines rl
    join public.receipts r on r.id = rl.receipt_id
    left join public.inventory_items ii on ii.id = rl.inventory_item_id
    where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
    group by 1
  ),
  supplier_totals as (
    select coalesce(r.supplier, '未標示供應商') as supplier, sum(re.effective_amount) as amount
    from receipt_effective re
    join public.receipts r on r.id = re.id
    group by 1
  ),
  prev_month_total as (
    select sum(coalesce(r.total_amount, (select sum(rl.total_price) from public.receipt_lines rl where rl.receipt_id = r.id))) as total
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= prev_month_start and r.purchase_date < month_start
  )
  select
    coalesce((select sum(effective_amount) from receipt_effective), 0),
    (select count(*) from receipt_effective)::int,
    (select count(*) from public.receipt_lines rl join public.receipts r on r.id = rl.receipt_id
      where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end)::int,
    (select category from category_totals order by amount desc nulls last limit 1),
    (select amount from category_totals order by amount desc nulls last limit 1),
    (select supplier from supplier_totals order by amount desc nulls last limit 1),
    (select amount from supplier_totals order by amount desc nulls last limit 1),
    coalesce((select total from prev_month_total), 0);
end;
$$;

create or replace function public.get_purchase_monthly_trend(p_end_month date, p_months integer default 12)
returns table (month date, total_amount numeric)
language plpgsql security invoker set search_path = public as $$
declare
  end_month date := date_trunc('month', p_end_month)::date;
  start_month date := (date_trunc('month', p_end_month) - ((greatest(p_months, 1) - 1) || ' months')::interval)::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  with months as (
    select generate_series(start_month, end_month, interval '1 month')::date as month
  ),
  receipt_effective as (
    select date_trunc('month', r.purchase_date)::date as month,
      coalesce(r.total_amount, (select sum(rl.total_price) from public.receipt_lines rl where rl.receipt_id = r.id)) as effective_amount
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= start_month and r.purchase_date < (end_month + interval '1 month')::date
  )
  select m.month, coalesce(sum(re.effective_amount), 0)
  from months m
  left join receipt_effective re on re.month = m.month
  group by m.month
  order by m.month;
end;
$$;

create or replace function public.get_purchase_category_breakdown(p_month date)
returns table (category text, total_amount numeric, incomplete_line_count integer)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  select coalesce(rl.category, ii.category, '未分類') as category,
    coalesce(sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)), 0),
    count(*) filter (where rl.total_price is null and (rl.quantity is null or rl.unit_price is null))::int
  from public.receipt_lines rl
  join public.receipts r on r.id = rl.receipt_id
  left join public.inventory_items ii on ii.id = rl.inventory_item_id
  where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
  group by 1
  order by 2 desc nulls last;
end;
$$;

create or replace function public.get_purchase_top_items(p_month date, p_limit integer default 10)
returns table (item_name text, total_amount numeric, total_quantity numeric, unit text)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  select rl.item_name,
    coalesce(sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)), 0),
    sum(rl.quantity),
    max(rl.unit)
  from public.receipt_lines rl
  join public.receipts r on r.id = rl.receipt_id
  where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
  group by rl.item_name
  order by 2 desc nulls last
  limit greatest(p_limit, 1);
end;
$$;

create or replace function public.get_purchase_supplier_breakdown(p_month date)
returns table (supplier text, total_amount numeric, receipt_count integer)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  select coalesce(r.supplier, '未標示供應商') as supplier,
    coalesce(sum(coalesce(r.total_amount, (select sum(rl.total_price) from public.receipt_lines rl where rl.receipt_id = r.id))), 0),
    count(*)::int
  from public.receipts r
  where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
  group by 1
  order by 2 desc nulls last;
end;
$$;

create or replace function public.get_purchase_report_lines(
  p_month date, p_category text default null, p_supplier text default null, p_keyword text default null
)
returns table (
  receipt_id uuid, purchase_date date, supplier text, invoice_number text, status text, receipt_total_amount numeric,
  line_id uuid, item_name text, category text, quantity numeric, unit text,
  unit_price numeric, total_price numeric, effective_amount numeric
)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  select r.id, r.purchase_date, r.supplier, r.invoice_number, r.status, r.total_amount,
    rl.id, rl.item_name, coalesce(rl.category, ii.category, '未分類'), rl.quantity, rl.unit,
    rl.unit_price, rl.total_price, coalesce(rl.total_price, rl.quantity * rl.unit_price)
  from public.receipt_lines rl
  join public.receipts r on r.id = rl.receipt_id
  left join public.inventory_items ii on ii.id = rl.inventory_item_id
  where r.status = 'stocked'
    and r.purchase_date >= month_start and r.purchase_date < month_end
    and (p_category is null or coalesce(rl.category, ii.category, '未分類') = p_category)
    and (p_supplier is null or coalesce(r.supplier, '未標示供應商') = p_supplier)
    and (p_keyword is null or rl.item_name ilike '%' || p_keyword || '%')
  order by r.purchase_date desc, r.id, rl.item_name;
end;
$$;

revoke all on function public.get_purchase_monthly_summary(date) from public;
grant execute on function public.get_purchase_monthly_summary(date) to authenticated;

revoke all on function public.get_purchase_monthly_trend(date, integer) from public;
grant execute on function public.get_purchase_monthly_trend(date, integer) to authenticated;

revoke all on function public.get_purchase_category_breakdown(date) from public;
grant execute on function public.get_purchase_category_breakdown(date) to authenticated;

revoke all on function public.get_purchase_top_items(date, integer) from public;
grant execute on function public.get_purchase_top_items(date, integer) to authenticated;

revoke all on function public.get_purchase_supplier_breakdown(date) from public;
grant execute on function public.get_purchase_supplier_breakdown(date) to authenticated;

revoke all on function public.get_purchase_report_lines(date, text, text, text) from public;
grant execute on function public.get_purchase_report_lines(date, text, text, text) to authenticated;
