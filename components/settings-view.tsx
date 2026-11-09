"use client";

import { ArrowDown, ArrowUp, ChevronsUp, GripVertical, LoaderCircle, Pencil, Plus, Power, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { useRef, useState } from "react";
import type { InventoryCategory } from "@/lib/types";
import { ActionMenu } from "./action-menu";
import { useDialogFocus } from "./use-dialog";

type Orphan = { name: string; itemCount: number; receiptLineCount: number };
type Notice = { message: string; error?: boolean; undo?: () => Promise<void> };

const RETENTION_OPTIONS = [30, 60, 90, 180, 365];

export function SettingsView({ categories, categoriesLoading, categoriesError, categoriesDemo, orphans, canManageCategories, onRetryCategories, retentionDays, canEditRetention, onAddCategory, onRenameCategory, onReorderCategories, onToggleCategoryActive, onDeleteCategory, onRetentionChange }: {
  categories: InventoryCategory[];
  categoriesLoading: boolean;
  categoriesError: string;
  categoriesDemo: boolean;
  orphans: Orphan[];
  canManageCategories: boolean;
  onRetryCategories: () => void;
  retentionDays: number;
  canEditRetention: boolean;
  onAddCategory: (name: string) => Promise<string | void>;
  onRenameCategory: (id: string, name: string) => Promise<string | void>;
  onReorderCategories: (ids: string[]) => Promise<string | void>;
  onToggleCategoryActive: (id: string, active: boolean) => Promise<string | void>;
  onDeleteCategory: (id: string) => Promise<string | void>;
  onRetentionChange: (days: number) => Promise<string | void>;
}) {
  const [name, setName] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [deleting, setDeleting] = useState<InventoryCategory | null>(null);
  const [retentionError, setRetentionError] = useState("");
  const [retentionSaving, setRetentionSaving] = useState(false);

  const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const active = sorted.filter((c) => c.active);
  const inactive = sorted.filter((c) => !c.active);
  const used = (c: InventoryCategory) => c.itemCount + c.receiptLineCount > 0;
  const usageText = (c: InventoryCategory) => used(c) ? `${c.itemCount} 項庫存品項、${c.receiptLineCount} 筆進貨紀錄` : "還沒有被使用";
  const editable = canManageCategories && !categoriesDemo;

  const runRowAction = async (id: string, action: () => Promise<string | void>): Promise<boolean> => {
    setRowError(null);
    setBusyId(id);
    const error = await action();
    setBusyId(null);
    if (error) { setRowError({ id, message: error }); return false; }
    return true;
  };

  // 在「啟用中」的分類裡移動一格或移到最前，再把停用的接在後面，整份順序一次送出。
  const moveToIndex = async (category: InventoryCategory, to: number) => {
    const list = [...active];
    const from = list.findIndex((c) => c.id === category.id);
    if (from < 0 || to < 0 || to >= list.length || to === from) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    // 停用的分類留在原本的位置，只在啟用分類佔的位置之間重新排，之後重新啟用才會回到原位。
    let next = 0;
    const fullOrder = sorted.map((c) => c.active ? list[next++].id : c.id);
    await runRowAction(category.id, () => onReorderCategories(fullOrder));
  };
  const move = (category: InventoryCategory, how: "up" | "down" | "top") => {
    const from = active.findIndex((c) => c.id === category.id);
    return moveToIndex(category, how === "top" ? 0 : how === "up" ? from - 1 : from + 1);
  };
  // 拖曳排序（滑鼠）：只能在「啟用中」的分類之間拖；手機、鍵盤用「⋯」選單的上移／下移／移到最前。
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dropOn = async (target: InventoryCategory) => {
    const id = dragId;
    setDragId(null); setOverId(null);
    if (!id || id === target.id) return;
    const moving = active.find((c) => c.id === id);
    const to = active.findIndex((c) => c.id === target.id);
    if (moving && to >= 0) await moveToIndex(moving, to);
  };

  const saveRename = async (category: InventoryCategory) => {
    const value = editingName.trim();
    if (!value) { setRowError({ id: category.id, message: "請輸入分類名稱。" }); return; }
    if (value === category.name) { setEditingId(null); return; }
    const ok = await runRowAction(category.id, () => onRenameCategory(category.id, value));
    if (ok) {
      setEditingId((current) => current === category.id ? null : current);
      setNotice({ message: used(category) ? `已把「${category.name}」改名為「${value}」，底下 ${category.itemCount} 項庫存品項和 ${category.receiptLineCount} 筆進貨紀錄也一起改過了。` : `已把「${category.name}」改名為「${value}」。` });
    }
  };

  const setActive = async (category: InventoryCategory, next: boolean): Promise<boolean> => {
    const ok = await runRowAction(category.id, () => onToggleCategoryActive(category.id, next));
    if (ok) setNotice(next
      ? { message: `已重新啟用「${category.name}」，新增品項和進貨單時又可以選它了。` }
      : { message: `已停用「${category.name}」，新增品項和進貨單時不能再選；舊資料都還在。`, undo: async () => { await setActive(category, true); } });
    return ok;
  };

  const addOrphan = async (orphan: Orphan) => {
    const ok = await runRowAction(`orphan:${orphan.name}`, () => onAddCategory(orphan.name));
    if (ok) setNotice({ message: `已把「${orphan.name}」加回分類清單，原本掛著這個名稱的品項和進貨紀錄現在找得到它了。` });
  };

  const undo = async () => {
    if (!notice?.undo) return;
    setUndoing(true);
    try { await notice.undo(); } finally { setUndoing(false); }
  };

  const renderRow = (category: InventoryCategory, index: number, list: InventoryCategory[]) => {
    const isEditing = editingId === category.id;
    const busy = busyId === category.id;
    // 有任何一列正在處理、或正在編輯某一列時，其他列的操作先鎖住，避免互相蓋掉。
    const locked = busyId !== null || (editingId !== null && editingId !== category.id);
    const canDrag = editable && category.active && !locked;
    return <div key={category.id}
      className={`category-row${category.active ? "" : " category-inactive"}${dragId === category.id ? " is-dragging" : ""}${overId === category.id && dragId && dragId !== category.id ? " is-drop-target" : ""}`}
      onDragOver={(e) => { if (dragId && category.active && dragId !== category.id) { e.preventDefault(); setOverId(category.id); } }}
      onDragLeave={() => setOverId((current) => current === category.id ? null : current)}
      onDrop={(e) => { e.preventDefault(); void dropOn(category); }}>
      {isEditing ? <div className="category-edit">
        <input value={editingName} maxLength={50} onChange={(e) => setEditingName(e.target.value)} aria-label="分類名稱" autoFocus onKeyDown={(e) => { if (e.key === "Enter") saveRename(category); if (e.key === "Escape") { setEditingId(null); setRowError(null); } }} />
        <button type="button" className="row-text-button" disabled={busy} onClick={() => saveRename(category)}>{busy ? "儲存中…" : "儲存"}</button>
        <button type="button" className="row-text-button" disabled={busy} onClick={() => { setEditingId(null); setRowError(null); }}>取消</button>
        {used(category) && <small className="field-hint">改名後，底下的 {usageText(category)} 會一起改成新名稱。</small>}
      </div> : <>
        <div className="category-name"><strong>{category.name}</strong>{!category.active && <em className="inactive-label">已停用</em>}<small>{usageText(category)}</small></div>
        {editable && <div className="category-actions">
          {category.active && <span className={canDrag ? "drag-handle" : "drag-handle is-disabled"} draggable={canDrag} title="按住拖曳可以調整順序（也可以用右邊「⋯」選單的上移、下移）"
            onDragStart={(e) => { setDragId(category.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", category.id); const row = (e.currentTarget as HTMLElement).closest(".category-row"); if (row) e.dataTransfer.setDragImage(row, 20, 20); }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}><GripVertical size={16} aria-hidden="true" /></span>}
          <ActionMenu label={`${category.name}的更多操作`} items={[
            { label: "移到最前", icon: ChevronsUp, onClick: () => move(category, "top"), hidden: !category.active, disabled: locked || index === 0 },
            { label: "上移", icon: ArrowUp, onClick: () => move(category, "up"), hidden: !category.active, disabled: locked || index === 0 },
            { label: "下移", icon: ArrowDown, onClick: () => move(category, "down"), hidden: !category.active, disabled: locked || index === list.length - 1 },
            { label: "改名", icon: Pencil, onClick: () => { setEditingId(category.id); setEditingName(category.name); setRowError(null); }, disabled: locked },
            category.active
              ? { label: "停用", icon: Power, onClick: () => { void setActive(category, false); }, disabled: locked, note: "停用後新增品項時不能再選，舊資料保留" }
              : { label: "重新啟用", icon: Power, onClick: () => { void setActive(category, true); }, disabled: locked },
            { label: "刪除", icon: Trash2, onClick: () => setDeleting(category), danger: true, disabled: locked || used(category), note: used(category) ? "還有品項或進貨紀錄在用，不能刪除" : undefined },
          ]} />
        </div>}
      </>}
      {rowError?.id === category.id && <div className="error-box" role="alert">{rowError.message}</div>}
    </div>;
  };

  return <><div className="section-header"><div><h1>系統設定</h1><p>管理品項分類，以及進貨單照片要保存多久。</p></div></div>
    {notice && <div className={notice.error ? "error-box inventory-notice" : "inventory-notice"} role={notice.error ? "alert" : "status"}>
      <span>{notice.message}</span>
      {notice.undo && <button type="button" className="text-button" onClick={undo} disabled={undoing}><Undo2 size={14} />{undoing ? "復原中…" : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setNotice(null)}><X size={14} /></button>
    </div>}
    <div className="settings-grid">
    <section className="settings-card">
      <header><h2>品項分類管理</h2><p>庫存品項和進貨單都從這裡的分類選；所有人看到的是同一份。</p></header>
      <details className="movement-help"><summary>改名、停用、刪除有什麼差別</summary>
        <ul className="report-help-list">
          <li><b>改名</b>：這個分類底下的庫存品項和歷史進貨紀錄會一起改成新名稱。</li>
          <li><b>停用</b>：新增品項、建立進貨單時不能再選它，但舊資料都保留，隨時可以重新啟用。暫時不用請用這個。</li>
          <li><b>刪除</b>：只有完全沒被使用的分類才能刪，刪掉就不能復原。</li>
        </ul>
      </details>
      {categoriesDemo && <div className="warning-box"><span>• 尚未設定Supabase，目前只顯示示範分類，無法新增、改名、停用或刪除。</span></div>}
      {!categoriesDemo && !canManageCategories && <div className="warning-box"><span>• 只有管理員可以新增、改名、停用、刪除或調整分類順序，你目前可以查看。</span></div>}
      {!categoriesDemo && !categoriesLoading && categories.length === 0 && !categoriesError && <div className="warning-box"><span>• 目前看不到任何分類。若確定已有分類，請管理員確認你的帳號是「使用中」的員工。</span></div>}
      {categoriesError && <div className="error-box inventory-notice" role="alert"><span>{categoriesError}</span><button type="button" className="text-button" onClick={onRetryCategories}><RefreshCw size={14} />重新載入</button></div>}

      {orphans.length > 0 && <div className="warning-box category-orphans" role="status">
        <span>• 有品項或進貨紀錄用到「不在分類清單裡」的名稱（通常是以前改名沒有一起改到）。它們在下拉選單和報表裡會被當成另一個分類。</span>
        <ul>{orphans.map((o) => <li key={o.name}>
          <span><strong>{o.name}</strong><small>{o.itemCount} 項庫存品項、{o.receiptLineCount} 筆進貨紀錄</small></span>
          {editable && <button type="button" className="row-text-button" disabled={busyId === `orphan:${o.name}`} onClick={() => addOrphan(o)}>{busyId === `orphan:${o.name}` ? "加入中…" : "加回分類清單"}</button>}
          {rowError?.id === `orphan:${o.name}` && <div className="error-box" role="alert">{rowError.message}</div>}
        </li>)}</ul>
      </div>}

      {editable && <form className="category-add-form" onSubmit={async (e) => {
        e.preventDefault();
        const value = name.trim();
        if (!value) return;
        setSubmitting(true);
        setFormError("");
        const error = await onAddCategory(value);
        setSubmitting(false);
        if (error) { setFormError(error); return; }
        setName("");
        setNotice({ message: `已新增分類「${value}」，排在最後面。` });
      }}>
        <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="新分類名稱，例如：飲料、火鍋用品" disabled={submitting} aria-label="新分類名稱" />
        <button className="primary-button" disabled={submitting || !name.trim()}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}新增分類</button>
      </form>}
      {formError && <div className="error-box" role="alert">{formError}</div>}

      {categoriesLoading && categories.length === 0 ? <p className="panel-empty">載入分類中…</p> : <>
        <div className="category-list">{active.map((c, i) => renderRow(c, i, active))}</div>
        {inactive.length > 0 && <details className="category-inactive-group">
          <summary>已停用的分類（{inactive.length}）</summary>
          <div className="category-list">{inactive.map((c, i) => renderRow(c, i, inactive))}</div>
        </details>}
      </>}
    </section>

    <section className="settings-card">
      <header><h2>進貨單照片保存</h2><p>進貨單拍的照片存在只有登入員工才看得到的私人空間。</p></header>
      <label className="retention-option">已入庫的照片保存天數<select value={retentionDays} disabled={!canEditRetention || retentionSaving} onChange={async (e) => {
        const days = Number(e.target.value);
        setRetentionSaving(true); setRetentionError("");
        const error = await onRetentionChange(days);
        setRetentionSaving(false);
        if (error) setRetentionError(error); else setNotice({ message: `已改成保存 ${days} 天。只影響之後新保存的進貨單，已經存的照片照原本的期限。` });
      }}>{RETENTION_OPTIONS.map((d) => <option key={d} value={d}>{d} 天{d === 90 ? "（建議）" : ""}</option>)}</select></label>
      {retentionSaving && <p className="field-hint">儲存中…</p>}
      {!canEditRetention && <div className="setting-note">只有管理員與訂貨管家可以修改保存天數；這個設定所有員工共用。</div>}
      {retentionError && <div className="error-box" role="alert">{retentionError}</div>}
      <ul className="report-help-list">
        <li>已入庫的進貨單：照片保存到上面設定的天數，之後自動清理。</li>
        <li>上傳到一半取消：照片馬上刪除。</li>
        <li>辨識失敗的暫存照片：24 小時後刪除。</li>
        <li>修改天數只影響之後新保存的進貨單。</li>
      </ul>
    </section>
  </div>

  {deleting && <DeleteCategoryModal category={deleting} onClose={() => setDeleting(null)} onConfirm={async () => {
    const error = await onDeleteCategory(deleting.id);
    if (error) return error;
    setNotice({ message: `已刪除分類「${deleting.name}」。` });
    setDeleting(null);
  }} />}
  </>;
}

function DeleteCategoryModal({ category, onClose, onConfirm }: { category: InventoryCategory; onClose: () => void; onConfirm: () => Promise<string | void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const run = async () => {
    setSubmitting(true); submittingRef.current = true; setError("");
    const failure = await onConfirm();
    setSubmitting(false); submittingRef.current = false;
    if (failure) setError(failure);
  };
  // 開啟時焦點放在「取消」，Tab 只在視窗內循環，按 Esc 可關閉，關閉後焦點回到原本按下的按鈕。
  useDialogFocus(dialogRef, onClose, () => submittingRef.current);
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}><div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-category-title">
    <header><div><h2 id="delete-category-title">刪除分類「{category.name}」？</h2><p>刪除後無法復原</p></div><button onClick={onClose} disabled={submitting} aria-label="關閉" title="關閉"><X /></button></header>
    <div className="modal-body">
      <p>這個分類目前沒有任何庫存品項或進貨紀錄在用，所以可以刪除。刪掉之後要用的話，需要重新新增。</p>
      <p className="field-hint">如果只是暫時不用，建議改成「停用」，之後還能重新啟用。</p>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" data-autofocus className="secondary-button" onClick={onClose} disabled={submitting}>取消</button><button className="primary-button danger-button" onClick={run} disabled={submitting}>{submitting ? "刪除中…" : "確定刪除"}</button></div>
    </div>
  </div></div>;
}
