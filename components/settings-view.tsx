"use client";

import { ArrowDown, ArrowUp, Check, LoaderCircle, Pencil, Plus, Power, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { InventoryCategory } from "@/lib/types";

export function SettingsView({ categories, categoriesLoading, categoriesError, categoriesDemo, retentionDays, canEditRetention, onAddCategory, onRenameCategory, onReorderCategory, onToggleCategoryActive, onDeleteCategory, onRetentionChange }: {
  categories: InventoryCategory[];
  categoriesLoading: boolean;
  categoriesError: string;
  categoriesDemo: boolean;
  retentionDays: number;
  canEditRetention: boolean;
  onAddCategory: (name: string) => Promise<string | void>;
  onRenameCategory: (id: string, name: string) => Promise<string | void>;
  onReorderCategory: (id: string, direction: "up" | "down") => Promise<string | void>;
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
  const [retentionError, setRetentionError] = useState("");
  const [retentionSaving, setRetentionSaving] = useState(false);

  const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

  const runRowAction = async (id: string, action: () => Promise<string | void>) => {
    setRowError(null);
    setBusyId(id);
    const error = await action();
    setBusyId(null);
    if (error) setRowError({ id, message: error });
  };

  return <><div className="section-header"><div><h1>系統設定</h1><p>管理庫存分類與進貨單照片保存方式。</p></div></div><div className="settings-grid">
    <section className="settings-card">
      <header><h2>品項分類管理</h2><p>分類會即時同步到Supabase，所有登入人員看到的資料一致。</p></header>
      {categoriesDemo && <div className="warning-box"><span>• 尚未設定Supabase，目前僅顯示唯讀示範分類，無法新增／修改／刪除。</span></div>}
      {!categoriesDemo && !categoriesLoading && categories.length === 0 && !categoriesError && <div className="warning-box"><span>• 目前看不到任何分類。若確定資料庫已有分類，請確認管理員已將你的帳號加入staff_profiles並設為active。</span></div>}
      <form onSubmit={async (e) => {
        e.preventDefault();
        const value = name.trim();
        if (!value) return;
        setSubmitting(true);
        setFormError("");
        const error = await onAddCategory(value);
        setSubmitting(false);
        if (error) { setFormError(error); return; }
        setName("");
      }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：飲料、火鍋用品" disabled={submitting} />
        <button className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}新增分類</button>
      </form>
      {formError && <div className="error-box">{formError}</div>}
      {categoriesError && <div className="error-box">{categoriesError}</div>}

      {categoriesLoading ? <p>載入分類中…</p> : <div className="category-list">
        {sorted.map((category, index) => {
          const editing = editingId === category.id;
          const busy = busyId === category.id;
          return <div key={category.id} className={category.active ? "" : "category-inactive"}>
            {editing ? <>
              <input value={editingName} onChange={(e) => setEditingName(e.target.value)} autoFocus />
              <button aria-label="儲存名稱" title="儲存名稱" disabled={busy} onClick={() => runRowAction(category.id, async () => {
                const value = editingName.trim();
                if (!value) return "請輸入分類名稱。";
                const error = await onRenameCategory(category.id, value);
                if (!error) setEditingId(null);
                return error;
              })}><Check size={16} /></button>
              <button aria-label="取消編輯" title="取消編輯" onClick={() => { setEditingId(null); setRowError(null); }}><X size={16} /></button>
            </> : <>
              <span>{category.name}{!category.active && <em className="inactive-label">已停用</em>}</span>
              <small>{category.itemCount + category.receiptLineCount > 0 ? `使用中：庫存${category.itemCount}項／進貨紀錄${category.receiptLineCount}筆` : "尚未被使用"}</small>
              <div className="category-actions">
                <button aria-label="上移" title="上移" disabled={busy || index === 0} onClick={() => runRowAction(category.id, () => onReorderCategory(category.id, "up"))}><ArrowUp size={15} /></button>
                <button aria-label="下移" title="下移" disabled={busy || index === sorted.length - 1} onClick={() => runRowAction(category.id, () => onReorderCategory(category.id, "down"))}><ArrowDown size={15} /></button>
                <button aria-label="編輯名稱" title="編輯名稱" disabled={busy} onClick={() => { setEditingId(category.id); setEditingName(category.name); setRowError(null); }}><Pencil size={15} /></button>
                <button aria-label={category.active ? "停用分類" : "啟用分類"} title={category.active ? "停用分類" : "啟用分類"} disabled={busy} onClick={() => runRowAction(category.id, () => onToggleCategoryActive(category.id, !category.active))}><Power size={15} /></button>
                <button className="danger" aria-label={`刪除${category.name}`} title={`刪除${category.name}`} disabled={busy} onClick={() => runRowAction(category.id, () => onDeleteCategory(category.id))}><Trash2 size={15} /></button>
              </div>
            </>}
            {rowError?.id === category.id && <div className="error-box">{rowError.message}</div>}
          </div>;
        })}
      </div>}
    </section>
    <section className="settings-card"><header><h2>進貨單照片保存</h2><p>正式模式會將照片放在Supabase Private Bucket。</p></header><label className="retention-option">保存天數<select value={retentionDays} disabled={!canEditRetention || retentionSaving} onChange={async (e) => { setRetentionSaving(true); setRetentionError(""); const error = await onRetentionChange(Number(e.target.value)); setRetentionSaving(false); if (error) setRetentionError(error); }}><option value={30}>30天</option><option value={60}>60天</option><option value={90}>90天（建議）</option><option value={180}>180天</option><option value={365}>365天</option></select></label>{!canEditRetention && <div className="setting-note">只有管理員與訂貨管家可以修改保存天數；此設定所有員工共用。</div>}{retentionError && <div className="error-box">{retentionError}</div>}<div className="setting-note">使用者取消上傳時立即刪除；辨識失敗的暫存照片24小時後刪除；已入庫照片依此處設定自動清理（修改後只影響之後新保存的進貨單）。</div></section>
  </div></>;
}
