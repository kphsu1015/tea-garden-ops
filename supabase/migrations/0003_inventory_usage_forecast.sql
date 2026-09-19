-- 預估使用量與庫存盤點：為inventory_items新增預估使用量欄位。
-- 請在Supabase SQL Editor執行，需先執行過 schema.sql、0001_inventory_category_management.sql、0002_inventory_item_management.sql。
-- 不會建立新資料表、不會修改既有欄位型別、不會刪除既有資料。
-- 手動盤點／修正庫存沿用schema.sql既有的 record_stock_movement() 函式與RLS政策，此檔不新增任何RLS政策。

alter table public.inventory_items
  add column if not exists usage_forecast_enabled boolean not null default false,
  add column if not exists estimated_usage numeric(12,2),
  add column if not exists usage_period text;

alter table public.inventory_items
  add constraint inventory_items_usage_period_check
  check (usage_period is null or usage_period in ('daily','weekly','monthly'));

-- 啟用預估使用量時，estimated_usage必須大於0且usage_period必須有值；
-- 未啟用時兩欄位都必須是NULL，避免停用後留下過期的預估數字造成誤判。
alter table public.inventory_items
  add constraint inventory_items_usage_forecast_check
  check (
    (usage_forecast_enabled = false and estimated_usage is null and usage_period is null)
    or
    (usage_forecast_enabled = true and estimated_usage is not null and estimated_usage > 0 and usage_period is not null)
  );
