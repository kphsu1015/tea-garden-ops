"use client";

import { Camera, Check, FileImage, LoaderCircle, Plus, ScanLine, ShieldCheck, Upload, X } from "lucide-react";
import Image from "next/image";
import { useRef, useState } from "react";
import { compressImage } from "@/lib/compress-image";
import { PENDING_CATEGORY } from "@/lib/categories-shared";
import { formatNumber } from "@/lib/format";
import { generateId } from "@/lib/id";
import { findExactInventoryMatch, findSimilarInventoryItems } from "@/lib/inventory";
import { formatCurrency } from "@/lib/purchase-report";
import { createClient } from "@/lib/supabase/client";
import type { InventoryItem, ReceiptLine, ReceiptRecord, UsagePeriod } from "@/lib/types";

type RawAnalysisLine = { itemName: string; quantity: number; unit: string; unitPrice?: number; totalPrice?: number; category?: string };
type AnalysisResponse = {
  supplier?: string;
  purchaseDate?: string;
  invoiceNumber?: string;
  totalAmount?: number;
  warnings?: string[];
  lines: RawAnalysisLine[];
  demo?: boolean;
  error?: string;
};

type LineAction = "existing" | "create_new" | "ignore";

interface NewItemDraft {
  name: string;
  category: string;
  unit: string;
  location: string;
  safetyStock: number;
  usageForecastEnabled: boolean;
  estimatedUsage: number;
  usagePeriod: UsagePeriod;
}

interface WorkingLine {
  id: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  category?: string;
  // null：尚未對應庫存，需要管理員選擇；不可自動建立新品項。
  action: LineAction | null;
  selectedExistingId?: string;
  newItem: NewItemDraft;
}

interface WorkingAnalysis {
  supplier: string;
  purchaseDate: string;
  invoiceNumber: string;
  totalAmount?: number;
  warnings: string[];
  lines: WorkingLine[];
}

function buildNewItemDraft(line: { itemName: string; unit: string; category?: string }, categories: string[]): NewItemDraft {
  const suggestedCategory = line.category && line.category !== PENDING_CATEGORY && categories.includes(line.category) ? line.category : (categories[0] || "");
  return {
    name: line.itemName,
    category: suggestedCategory,
    unit: line.unit,
    location: "",
    safetyStock: 0,
    usageForecastEnabled: false,
    estimatedUsage: 1,
    usagePeriod: "daily",
  };
}

function isLineResolved(line: WorkingLine): boolean {
  if (line.action === "existing") return Boolean(line.selectedExistingId);
  if (line.action === "ignore") return true;
  if (line.action === "create_new") {
    const d = line.newItem;
    if (!d.name.trim() || !d.category.trim() || !d.unit.trim() || !d.location.trim()) return false;
    if (d.usageForecastEnabled && !(d.estimatedUsage > 0)) return false;
    return true;
  }
  return false;
}

export function ReceiptScanner({ inventory, categories, receipts, retentionDays, onConfirm }: {
  inventory: InventoryItem[];
  categories: string[];
  receipts: ReceiptRecord[];
  retentionDays: number;
  onConfirm: (record: ReceiptRecord) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [compressedBlob, setCompressedBlob] = useState<Blob | null>(null);
  const [analysis, setAnalysis] = useState<WorkingAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chooseFile = async (next: File | undefined) => {
    if (!next) return;
    setError("");
    setAnalysis(null);
    setFile(next);
    const compressed = await compressImage(next);
    setPreview(compressed.dataUrl);
    setCompressedBlob(compressed.blob);
  };

  const analyze = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const compressed = await compressImage(file);
      const response = await fetch("/api/receipts/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: compressed.base64, mimeType: compressed.mimeType }),
      });
      const result = await response.json() as AnalysisResponse;
      if (!response.ok || result.error) throw new Error(result.error || "辨識失敗");
      setAnalysis({
        supplier: result.supplier || "",
        purchaseDate: result.purchaseDate || "",
        invoiceNumber: result.invoiceNumber || "",
        totalAmount: result.totalAmount || undefined,
        warnings: result.warnings || [],
        lines: result.lines.map((line): WorkingLine => {
          const exactMatch = findExactInventoryMatch(inventory, line.itemName);
          return {
            id: generateId(),
            itemName: line.itemName,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice || undefined,
            totalPrice: line.totalPrice || undefined,
            category: line.category,
            action: exactMatch ? "existing" : null,
            selectedExistingId: exactMatch?.id,
            newItem: buildNewItemDraft(line, categories),
          };
        }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "辨識失敗");
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (id: string, patch: Partial<WorkingLine>) => {
    setAnalysis((prev) => prev ? { ...prev, lines: prev.lines.map((l) => l.id === id ? { ...l, ...patch } : l) } : prev);
  };
  const updateNewItem = (id: string, patch: Partial<NewItemDraft>) => {
    setAnalysis((prev) => prev ? { ...prev, lines: prev.lines.map((l) => l.id === id ? { ...l, newItem: { ...l.newItem, ...patch } } : l) } : prev);
  };
  const removeLine = (id: string) => {
    setAnalysis((prev) => prev ? { ...prev, lines: prev.lines.filter((l) => l.id !== id) } : prev);
  };

  const allResolved = Boolean(analysis && analysis.lines.length > 0 && analysis.lines.every(isLineResolved));

  const confirm = async () => {
    if (!analysis || !file || !allResolved) return;
    setBusy(true);
    setError("");
    try {
      let storagePath: string | undefined;
      if (process.env.NEXT_PUBLIC_SUPABASE_URL && compressedBlob) {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("請先以正式員工帳號登入，再保存進貨單照片。");
        storagePath = `${user.id}/${generateId()}.jpg`;
        const { error: uploadError } = await supabase.storage.from("receipts").upload(storagePath, compressedBlob, { contentType: "image/jpeg", upsert: false });
        if (uploadError) throw new Error(`照片保存失敗：${uploadError.message}`);

        const response = await fetch("/api/receipts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supplier: analysis.supplier || undefined,
            purchaseDate: analysis.purchaseDate || undefined,
            invoiceNumber: analysis.invoiceNumber || undefined,
            totalAmount: analysis.totalAmount,
            originalFileName: file.name,
            storagePath,
            warnings: analysis.warnings,
            retentionDays,
            lines: analysis.lines.map((line) => ({
              action: line.action,
              itemName: line.itemName,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              totalPrice: line.totalPrice,
              category: line.action === "create_new" ? line.newItem.category : line.category,
              inventoryItemId: line.action === "existing" ? line.selectedExistingId : undefined,
              newItem: line.action === "create_new" ? {
                name: line.newItem.name,
                category: line.newItem.category,
                unit: line.newItem.unit,
                location: line.newItem.location,
                safetyStock: line.newItem.safetyStock,
                usageForecastEnabled: line.newItem.usageForecastEnabled,
                estimatedUsage: line.newItem.usageForecastEnabled ? line.newItem.estimatedUsage : undefined,
                usagePeriod: line.newItem.usageForecastEnabled ? line.newItem.usagePeriod : undefined,
              } : undefined,
            })),
          }),
        });
        const result = await response.json() as { id?: string; error?: string };
        if (!response.ok || result.error) throw new Error(result.error || "進貨單保存失敗");
      }
      const createdAt = new Date();
      const deleteAfter = new Date(createdAt.getTime() + retentionDays * 86400000).toISOString();
      const finalLines: ReceiptLine[] = analysis.lines.map((line) => ({
        id: line.id,
        itemName: line.itemName,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        totalPrice: line.totalPrice,
        category: line.action === "create_new" ? line.newItem.category : line.category,
        inventoryItemId: line.action === "existing" ? line.selectedExistingId : undefined,
        resolution: line.action ?? undefined,
      }));
      onConfirm({
        supplier: analysis.supplier,
        purchaseDate: analysis.purchaseDate,
        invoiceNumber: analysis.invoiceNumber,
        totalAmount: analysis.totalAmount,
        warnings: analysis.warnings,
        lines: finalLines,
        id: generateId(),
        fileName: file.name,
        storagePath,
        status: "已入庫",
        createdAt: createdAt.toISOString(),
        deleteAfter,
        demo: !storagePath,
      });
      setFile(null);
      setPreview("");
      setCompressedBlob(null);
      setAnalysis(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "入庫失敗");
    } finally {
      setBusy(false);
    }
  };

  const lineAmountSum = analysis ? analysis.lines.reduce((sum, line) => sum + (line.totalPrice ?? 0), 0) : 0;
  const amountMismatch = analysis && typeof analysis.totalAmount === "number"
    ? Math.round((analysis.totalAmount - lineAmountSum) * 100) / 100
    : 0;

  return <>
    <div className="section-header receipt-title"><div><h1>進貨單辨識入庫</h1><p>拍照或上傳進貨單，確認辨識內容後再一次完成入庫。</p></div><span className="privacy-badge"><ShieldCheck size={18} />私人照片 · 保存{retentionDays}天</span></div>
    <div className="receipt-layout">
      <section className="upload-card">
        <input ref={fileRef} hidden type="file" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} />
        {!preview ? <button className="upload-zone" onClick={() => fileRef.current?.click()}><span><Camera size={30} /></span><strong>拍照或上傳進貨單</strong><small>支援JPG、PNG；系統會先自動壓縮照片</small><em><Upload size={16} />選擇照片</em></button> : <div className="receipt-preview"><Image src={preview} alt="待辨識進貨單" fill unoptimized /><button aria-label="移除照片" onClick={() => { setFile(null); setPreview(""); setCompressedBlob(null); setAnalysis(null); }}><X /></button></div>}
        {preview && !analysis && <button className="primary-button analyze-button" disabled={busy} onClick={analyze}>{busy ? <LoaderCircle className="spin" size={19} /> : <ScanLine size={19} />}{busy ? "AI辨識中…" : "開始辨識進貨單"}</button>}
        {error && <div className="error-box">{error}</div>}
      </section>

      <section className="analysis-card">
        {!analysis ? <div className="analysis-empty"><FileImage size={42} /><strong>辨識結果會顯示在這裡</strong><p>系統不會自動入庫，請先確認品項、數量與單位。</p></div> : <>
          <header><div><h2>確認辨識結果</h2><p>可直接修改AI辨識錯誤的欄位</p></div><span>{analysis.lines.length}項</span></header>
          <div className="receipt-meta"><label>供應商<input value={analysis.supplier} onChange={(e) => setAnalysis({ ...analysis, supplier: e.target.value })} /></label><label>進貨日期<input type="date" value={analysis.purchaseDate} onChange={(e) => setAnalysis({ ...analysis, purchaseDate: e.target.value })} /></label><label>單據號碼<input value={analysis.invoiceNumber || ""} onChange={(e) => setAnalysis({ ...analysis, invoiceNumber: e.target.value })} /></label></div>
          {analysis.warnings.length > 0 && <div className="warning-box">{analysis.warnings.map((warning) => <span key={warning}>• {warning}</span>)}</div>}
          <div className="receipt-lines">{analysis.lines.map((line) => <article key={line.id}>
            <button className="remove-line" aria-label="刪除品項" onClick={() => removeLine(line.id)}><X size={16} /></button>
            <label>品項名稱<input value={line.itemName} onChange={(e) => updateLine(line.id, { itemName: e.target.value })} /></label>
            <div className="line-grid"><label>數量<input type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => updateLine(line.id, { quantity: Number(e.target.value) })} /></label><label>單位<input value={line.unit} onChange={(e) => updateLine(line.id, { unit: e.target.value })} /></label><label>金額<input type="number" min="0" value={line.totalPrice || ""} onChange={(e) => updateLine(line.id, { totalPrice: Number(e.target.value) || undefined })} /></label></div>
            <ReceiptLineMatch line={line} inventory={inventory} categories={categories} onUpdate={(patch) => updateLine(line.id, patch)} onUpdateNewItem={(patch) => updateNewItem(line.id, patch)} />
          </article>)}</div>
          {!allResolved && <div className="warning-box"><span>• 還有品項尚未對應庫存，請先完成選擇（對應現有品項／建立新品項／忽略）再入庫。</span></div>}
          {Math.abs(amountMismatch) >= 1 && <div className="warning-box"><span>• 單據總額與品項金額加總不一致，差額 {formatCurrency(Math.abs(amountMismatch))}（{amountMismatch > 0 ? "單據較高" : "品項合計較高"}），請確認金額無誤後再入庫。</span></div>}
          <footer><div><small>單據總額</small><strong>{formatCurrency(analysis.totalAmount)}</strong></div><button className="primary-button" onClick={confirm} disabled={!analysis.lines.length || busy || !allResolved}>{busy ? "保存中…" : "確認並完成入庫"}</button></footer>
        </>}
      </section>
    </div>

    <section className="receipt-history"><h2>最近進貨單</h2>{receipts.length === 0 ? <p>尚無進貨單紀錄</p> : <div className="table-card"><table><thead><tr><th>上傳時間</th><th>供應商</th><th>檔案</th><th>品項</th><th>金額</th><th>照片保存至</th><th>狀態</th></tr></thead><tbody>{receipts.map((receipt) => <tr key={receipt.id}><td>{new Date(receipt.createdAt).toLocaleString("zh-TW")}</td><td>{receipt.supplier || "未辨識"}</td><td>{receipt.fileName}</td><td>{receipt.lines.length}項</td><td>{formatCurrency(receipt.totalAmount)}</td><td>{receipt.deleteAfter ? new Date(receipt.deleteAfter).toLocaleDateString("zh-TW") : "—"}</td><td><span className="pill">{receipt.status}</span></td></tr>)}</tbody></table></div>}</section>
  </>;
}

function ReceiptLineMatch({ line, inventory, categories, onUpdate, onUpdateNewItem }: {
  line: WorkingLine;
  inventory: InventoryItem[];
  categories: string[];
  onUpdate: (patch: Partial<WorkingLine>) => void;
  onUpdateNewItem: (patch: Partial<NewItemDraft>) => void;
}) {
  if (line.action === "existing") {
    const selected = line.selectedExistingId ? inventory.find((item) => item.id === line.selectedExistingId) : undefined;
    if (selected) {
      return <div className="line-match line-match-ok">
        <span><Check size={15} />對應庫存：<strong>{selected.name}</strong>（現有{formatNumber(selected.quantity)}{selected.unit}）</span>
        <button type="button" className="text-button" onClick={() => onUpdate({ action: null, selectedExistingId: undefined })}>改選</button>
      </div>;
    }
  }

  if (line.action === "create_new") {
    return <div className="line-match line-match-new">
      <div className="line-match-header"><strong>建立新庫存品項</strong><button type="button" className="text-button" onClick={() => onUpdate({ action: null })}>改選</button></div>
      {categories.length === 0 && <div className="warning-box"><span>• 目前沒有啟用中的分類，請先到「系統設定」新增或啟用分類。</span></div>}
      <div className="form-grid">
        <label>品項名稱<input required value={line.newItem.name} onChange={(e) => onUpdateNewItem({ name: e.target.value })} /></label>
        <label>大分類<select required disabled={categories.length === 0} value={line.newItem.category} onChange={(e) => onUpdateNewItem({ category: e.target.value })}><option value="">請選擇</option>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="form-grid">
        <label>計算單位<input required value={line.newItem.unit} onChange={(e) => onUpdateNewItem({ unit: e.target.value })} /></label>
        <label>存放位置<input required value={line.newItem.location} onChange={(e) => onUpdateNewItem({ location: e.target.value })} placeholder="例如：一樓備品室" /></label>
      </div>
      <label>安全庫存<input type="number" min="0" step="0.01" value={line.newItem.safetyStock} onChange={(e) => onUpdateNewItem({ safetyStock: Number(e.target.value) })} /></label>
      <label className="check-label"><input type="checkbox" checked={line.newItem.usageForecastEnabled} onChange={(e) => onUpdateNewItem({ usageForecastEnabled: e.target.checked })} />啟用預估使用量</label>
      {line.newItem.usageForecastEnabled && <div className="form-grid">
        <label>預估使用量（{line.newItem.unit || "單位"}）<input required type="number" min="0.01" step="0.01" value={line.newItem.estimatedUsage} onChange={(e) => onUpdateNewItem({ estimatedUsage: Number(e.target.value) })} /></label>
        <label>使用週期<select value={line.newItem.usagePeriod} onChange={(e) => onUpdateNewItem({ usagePeriod: e.target.value as UsagePeriod })}><option value="daily">每日</option><option value="weekly">每週</option><option value="monthly">每月</option></select></label>
      </div>}
    </div>;
  }

  if (line.action === "ignore") {
    return <div className="line-match line-match-ignore">
      <span>此品項將被忽略，不會建立或更新任何庫存。</span>
      <button type="button" className="text-button" onClick={() => onUpdate({ action: null })}>改選</button>
    </div>;
  }

  const similar = findSimilarInventoryItems(inventory, line.itemName, 5);
  return <div className="line-match line-match-unresolved">
    <div className="warning-box"><span>• 尚未對應庫存，請選擇以下其中一種處理方式。</span></div>
    {similar.length > 0 && <div className="line-match-similar">
      <small>相似的現有品項：</small>
      <div className="line-match-similar-list">{similar.map((item) => <button type="button" key={item.id} onClick={() => onUpdate({ action: "existing", selectedExistingId: item.id })}>{item.name}<small>現有{formatNumber(item.quantity)}{item.unit}</small></button>)}</div>
    </div>}
    <label>或從完整品項清單選擇<select value="" onChange={(e) => { if (e.target.value) onUpdate({ action: "existing", selectedExistingId: e.target.value }); }}><option value="">請選擇現有品項…</option>{inventory.map((item) => <option key={item.id} value={item.id}>{item.name}（現有{formatNumber(item.quantity)}{item.unit}）</option>)}</select></label>
    <div className="line-match-actions">
      <button type="button" className="secondary-button" onClick={() => onUpdate({ action: "create_new" })}><Plus size={15} />建立新庫存品項</button>
      <button type="button" className="secondary-button" onClick={() => onUpdate({ action: "ignore" })}>忽略此品項</button>
    </div>
  </div>;
}
