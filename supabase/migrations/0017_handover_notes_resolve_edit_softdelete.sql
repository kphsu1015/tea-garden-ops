-- 交接留言：已處理、編輯紀錄、可復原的刪除
-- handover_notes 的 resolved_at 在 schema.sql 就有了，這支補上：
--   resolved_by：誰標記已處理
--   edited_at：最後編輯時間（有編輯過才顯示「已編輯」）
--   deleted_at：軟刪除（管理員刪除後可以復原，列表不再顯示）
-- 在 Supabase SQL Editor 執行；可重複執行。

alter table public.handover_notes add column if not exists resolved_by uuid references public.staff_profiles(id);
alter table public.handover_notes add column if not exists edited_at timestamptz;
alter table public.handover_notes add column if not exists deleted_at timestamptz;

create index if not exists handover_notes_open_idx on public.handover_notes (created_at desc) where deleted_at is null;

-- 任何在職員工都可以把「別人寫的」留言標成已處理／改回未處理（交接就是下一班處理）。
-- 其他欄位（內容、分類、重要）仍只有作者或管理員能改（原本的 update 政策），
-- 所以這裡用一個只動 resolved_at／resolved_by 的函式，不放寬整張表的更新權限。
create or replace function public.set_note_resolved(p_id uuid, p_resolved boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.handover_notes
     set resolved_at = case when p_resolved then now() else null end,
         resolved_by = case when p_resolved then auth.uid() else null end
   where id = p_id and deleted_at is null;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.set_note_resolved(uuid, boolean) from public;
grant execute on function public.set_note_resolved(uuid, boolean) to authenticated;

-- 已刪除（deleted_at 有值）的留言，只有管理員讀得到（要復原用）；一般員工直接查資料庫也看不到。
drop policy if exists "active staff read notes" on public.handover_notes;
create policy "active staff read notes" on public.handover_notes
  for select using (
    public.is_active_staff()
    and (deleted_at is null or public.has_role(array['admin']::public.staff_role[]))
  );

-- 只有管理員能改 deleted_at（刪除／復原）。原本的 update 政策讓作者可以改自己整筆留言，
-- 這裡用觸發器把「刪除／復原」這個動作鎖給管理員，避免作者繞過 API 自己刪或復原。
create or replace function public.guard_note_deleted_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     and not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admins can delete or restore notes' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists handover_notes_guard_deleted_at on public.handover_notes;
create trigger handover_notes_guard_deleted_at
  before update on public.handover_notes
  for each row execute function public.guard_note_deleted_at();
