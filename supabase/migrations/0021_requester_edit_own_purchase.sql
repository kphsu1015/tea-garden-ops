-- 採購需求：提出需求的人可以修改或撤回「自己提出、還在待確認」的需求
-- 問題：原本只有管理員與訂貨管家能更新採購需求（RLS 的 update 政策）。管家提出需求時打錯數量或備註，
--       只能請別人幫忙改，也不能自己撤回。
-- 做法：不放寬整張表的更新權限（那樣管家就能改別人的需求、改狀態），而是新增一個受限的資料庫函式：
--   - 只有「提出這張需求的本人」可以呼叫
--   - 只能改「待確認」的需求（已訂購之後就不能改了）
--   - 只能改數量、備註，或撤回（撤回＝改成暫緩，跟既有的「取消＝暫緩」一致，管理員與訂貨管家可以恢復）
-- 在 Supabase SQL Editor 執行；可重複執行。不會修改任何現有資料（只新增函式）。

create or replace function public.requester_update_purchase(
  p_id uuid,
  p_quantity numeric default null,
  p_note text default null,
  p_set_note boolean default false,
  p_withdraw boolean default false
)
returns public.purchase_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.purchase_requests;
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into req from public.purchase_requests where id = p_id for update;
  if not found then
    raise exception 'purchase request not found' using errcode = 'P0002';
  end if;
  if req.requester_id is distinct from auth.uid() then
    raise exception 'not your request' using errcode = '42501';
  end if;
  -- approved 在畫面上也算「待確認」。
  if req.status not in ('pending', 'approved') then
    raise exception 'request is no longer pending' using errcode = 'P0012';
  end if;
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'quantity must be positive' using errcode = '22023';
  end if;
  if p_set_note and p_note is not null and char_length(p_note) > 500 then
    raise exception 'note too long' using errcode = '22023';
  end if;

  update public.purchase_requests
     set quantity = coalesce(p_quantity, quantity),
         note = case when p_set_note then nullif(btrim(coalesce(p_note, '')), '') else note end,
         status = case when p_withdraw then 'paused'::public.purchase_status else status end,
         updated_at = now()
   where id = p_id
   returning * into req;

  return req;
end;
$$;

revoke all on function public.requester_update_purchase(uuid, numeric, text, boolean, boolean) from public;
grant execute on function public.requester_update_purchase(uuid, numeric, text, boolean, boolean) to authenticated;
