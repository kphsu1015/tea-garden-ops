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
import { calculateAmountMismatch, calculateReceiptTotals, deriveChargeAmountFromLine, splitAnalysisLines, type RawAnalysisLine } from "@/lib/receipt-calc";
import { createClient } from "@/lib/supabase/client";
import type { InventoryItem, ReceiptCharge, ReceiptChargeType, ReceiptLine, ReceiptRecord, UsagePeriod } from "@/lib/types";

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

// 運費／處理費／稅額／折扣／其他費用：這些都不是庫存品項，確認入庫時只會保存到進貨單費用明細，
// 不會建立inventory_items，也不會增加庫存數量或建立stock_movements。
const CHARGE_TYPE_LABELS: Record<ReceiptChargeType, string> = {
  shipping: "運費",
  handling: "處理費／包裝費",
  tax: "稅額",
  discount: "折扣",
  other_fee: "其他費用",
};
const CHARGE_TYPES = Object.keys(CHARGE_TYPE_LABELS) as ReceiptChargeType[];

interface NewItemDraft {
  name: string;
  category: string;
  unit: string;
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

interface WorkingCharge {
  id: string;
  chargeType: ReceiptChargeType;
  description: string;
  amount: number;
}

interface WorkingAnalysis {
  supplier: string;
  purchaseDate: string;
  invoiceNumber: string;
  totalAmount?: number;
  warnings: string[];
  lines: WorkingLine[];
  charges: WorkingCharge[];
}

function buildNewItemDraft(line: { itemName: string; unit: string; category?: string }, categories: string[]): NewItemDraft {
  const suggestedCategory = line.category && line.category !== PENDING_CATEGORY && categories.includes(line.category) ? line.category : (categories[0] || "");
  return {
    name: line.itemName,
    category: suggestedCategory,
    unit: line.unit,
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
    if (!d.name.trim() || !d.category.trim() || !d.unit.trim()) return false;
    if (d.usageForecastEnabled && !(d.estimatedUsage > 0)) return false;
    return true;
  }
  return false;
}

function rawLineToWorkingLine(line: RawAnalysisLine, inventory: InventoryItem[], categories: string[]): WorkingLine {
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
}

function rawLineToWorkingCharge(line: RawAnalysisLine): WorkingCharge {
  return {
    id: generateId(),
    chargeType: (line.lineType && line.lineType !== "inventory" ? line.lineType : "other_fee"),
    description: line.itemName,
    amount: deriveChargeAmountFromLine({ totalPrice: line.totalPrice, unitPrice: line.unitPrice, quantity: line.quantity || 1 }),
  };
}

export function ReceiptScanner({ inventory, categories, receipts, retentionDays, onConfirm }: {
  inventory: InventoryItem[];
  categories: string[];
  receipts: ReceiptRecord[];
  retentionDays: number;
  onConfirm: (record: ReceiptRecord) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"scan" | "manual">("scan");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [compressedBlob, setCompressedBlob] = useState<Blob | null>(null);
  const [analysis, setAnalysis] = useState<WorkingAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const resetEntry = () => { setFile(null); setPreview(""); setCompressedBlob(null); setAnalysis(null); setError(""); };
  const switchMode = (next: "scan" | "manual") => { if (next !== mode) { setMode(next); resetEntry(); } };

  const chooseFile = async (next: File | undefined) => {
    if (!next) return;
    setError("");
    setAnalysis(null);
    setFile(next);
    const compressed = await compressImage(next);
    setPreview(compressed.dataUrl);
    setCompressedBlob(compressed.blob);
  };

  // 手動輸入：不需要照片，直接從空白進貨單開始填寫，沿用同一套庫存品項／其他費用確認流程。
  const startManualEntry = () => {
    setError("");
    setAnalysis({
      supplier: "", purchaseDate: new Date().toISOString().slice(0, 10), invoiceNumber: "",
      totalAmount: undefined, warnings: [], lines: [], charges: [],
    });
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
      const { inventoryLines, chargeLines } = splitAnalysisLines(result.lines);
      setAnalysis({
        supplier: result.supplier || "",
        purchaseDate: result.purchaseDate || "",
        invoiceNumber: result.invoiceNumber || "",
        totalAmount: result.totalAmount || undefined,
        warnings: result.warnings || [],
        lines: inventoryLines.map((line) => rawLineToWorkingLine(line, inventory, categories)),
        charges: chargeLines.map(rawLineToWorkingCharge),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "辨識失敗");
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (id: string, patch: Partial<WorkingLine>) => {
    // 這一列的「品項名稱」「單位」改變時，同步更新「建立新庫存品項」草稿的「品項名稱」「計算單位」——
    // 這些欄位幾乎都該填一樣的值，不用讓使用者打兩次；如果之後在草稿裡自己手動改成不同的值，
    // 那次手動修改仍然有效，不會被覆蓋。
    setAnalysis((prev) => {
      if (!prev) return prev;
      const syncPatch: Partial<NewItemDraft> = {};
      if (typeof patch.unit === "string") syncPatch.unit = patch.unit;
      if (typeof patch.itemName === "string") syncPatch.name = patch.itemName;
      return { ...prev, lines: prev.lines.map((l) => l.id === id ? {
        ...l, ...patch,
        newItem: Object.keys(syncPatch).length > 0 ? { ...l.newItem, ...syncPatch } : l.newItem,
      } : l) };
    });
  };
  const updateNewItem = (id: string, patch: Partial<NewItemDraft>) => {
    // 反方向同步：在「建立新庫存品項」草稿裡改名稱／單位，也要帶回這一列上方的「品項名稱」「單位」，
    // 不然手動輸入時（預設就是建立新品項）只填這裡的話，進貨單明細的品項名稱／單位會留空。
    setAnalysis((prev) => prev ? { ...prev, lines: prev.lines.map((l) => l.id === id ? {
      ...l,
      newItem: { ...l.newItem, ...patch },
      itemName: typeof patch.name === "string" ? patch.name : l.itemName,
      unit: typeof patch.unit === "string" ? patch.unit : l.unit,
    } : l) } : prev);
  };
  const removeLine = (id: string) => {
    setAnalysis((prev) => prev ? { ...prev, lines: prev.lines.filter((l) => l.id !== id) } : prev);
  };
  const updateCharge = (id: string, patch: Partial<WorkingCharge>) => {
    setAnalysis((prev) => prev ? { ...prev, charges: prev.charges.map((c) => c.id === id ? { ...c, ...patch } : c) } : prev);
  };
  const removeCharge = (id: string) => {
    setAnalysis((prev) => prev ? { ...prev, charges: prev.charges.filter((c) => c.id !== id) } : prev);
  };
  const addCharge = () => {
    setAnalysis((prev) => prev ? { ...prev, charges: [...prev.charges, { id: generateId(), chargeType: "other_fee", description: "", amount: 0 }] } : prev);
  };
  // 手動新增一筆要「建立新庫存品項」的空白列：手動打的品項名稱通常就是要新增的品項，
  // 直接預設為「建立新庫存品項」，不用使用者自己再多點一次；如果其實庫存裡已經有這個品項，
  // 可以點「改選」切回去選「對應現有庫存品項」，或改用旁邊的「選擇現有品項」按鈕。
  const addLine = () => {
    setAnalysis((prev) => prev ? { ...prev, lines: [...prev.lines, {
      id: generateId(), itemName: "", quantity: 1, unit: "", totalPrice: undefined, category: undefined,
      action: "create_new", newItem: buildNewItemDraft({ itemName: "", unit: "" }, categories),
    }] } : prev);
  };
  // 手動新增一筆要「對應現有庫存品項」的空白列：直接停在未解析狀態，讓使用者用大分類→品項挑既有品項，
  // 不用先經過「建立新庫存品項」畫面再點「改選」繞一圈。
  const addExistingLine = () => {
    setAnalysis((prev) => prev ? { ...prev, lines: [...prev.lines, {
      id: generateId(), itemName: "", quantity: 1, unit: "", totalPrice: undefined, category: undefined,
      action: null, newItem: buildNewItemDraft({ itemName: "", unit: "" }, categories),
    }] } : prev);
  };
  // AI誤判時，管理員可以手動把列在「庫存品項」與「其他費用」之間互相搬移。
  const moveLineToCharge = (id: string) => {
    setAnalysis((prev) => {
      if (!prev) return prev;
      const line = prev.lines.find((l) => l.id === id);
      if (!line) return prev;
      const charge: WorkingCharge = {
        id: line.id,
        chargeType: "other_fee",
        description: line.itemName,
        amount: deriveChargeAmountFromLine(line),
      };
      return { ...prev, lines: prev.lines.filter((l) => l.id !== id), charges: [...prev.charges, charge] };
    });
  };
  const moveChargeToLine = (id: string) => {
    setAnalysis((prev) => {
      if (!prev) return prev;
      const charge = prev.charges.find((c) => c.id === id);
      if (!charge) return prev;
      const line: WorkingLine = {
        id: charge.id,
        itemName: charge.description || CHARGE_TYPE_LABELS[charge.chargeType],
        quantity: 1,
        unit: "",
        totalPrice: charge.amount || undefined,
        category: undefined,
        action: null,
        newItem: buildNewItemDraft({ itemName: charge.description || CHARGE_TYPE_LABELS[charge.chargeType], unit: "" }, categories),
      };
      return { ...prev, charges: prev.charges.filter((c) => c.id !== id), lines: [...prev.lines, line] };
    });
  };

  const allLinesResolved = Boolean(analysis && analysis.lines.every(isLineResolved));
  const chargesValid = Boolean(analysis && analysis.charges.every((c) => Number.isFinite(c.amount) && c.amount >= 0));
  const hasAnyRow = Boolean(analysis && (analysis.lines.length > 0 || analysis.charges.length > 0));
  // 單據總額一定要填、且大於0才能送出，不管是AI辨識還是手動輸入都一樣，避免入庫卻沒有金額紀錄。
  const hasTotalAmount = Boolean(analysis && typeof analysis.totalAmount === "number" && analysis.totalAmount > 0);
  const allResolved = hasAnyRow && allLinesResolved && chargesValid && hasTotalAmount;

  const confirm = async () => {
    if (!analysis || !allResolved) return;
    setBusy(true);
    setError("");
    try {
      let storagePath: string | undefined;
      let persisted = false;
      if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("請先以正式員工帳號登入，再保存進貨單。");

        // 手動輸入沒有照片可上傳，storagePath留空即可，後端已改成可以不帶照片保存進貨單。
        if (compressedBlob) {
          storagePath = `${user.id}/${generateId()}.jpg`;
          const { error: uploadError } = await supabase.storage.from("receipts").upload(storagePath, compressedBlob, { contentType: "image/jpeg", upsert: false });
          if (uploadError) throw new Error(`照片保存失敗：${uploadError.message}`);
        }

        const response = await fetch("/api/receipts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supplier: analysis.supplier || undefined,
            purchaseDate: analysis.purchaseDate || undefined,
            invoiceNumber: analysis.invoiceNumber || undefined,
            totalAmount: analysis.totalAmount,
            originalFileName: file?.name || "手動輸入進貨單",
            storagePath,
            warnings: analysis.warnings,
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
                safetyStock: line.newItem.safetyStock,
                usageForecastEnabled: line.newItem.usageForecastEnabled,
                estimatedUsage: line.newItem.usageForecastEnabled ? line.newItem.estimatedUsage : undefined,
                usagePeriod: line.newItem.usageForecastEnabled ? line.newItem.usagePeriod : undefined,
              } : undefined,
            })),
            charges: analysis.charges.map((charge) => ({
              chargeType: charge.chargeType,
              description: charge.description || undefined,
              amount: charge.amount,
            })),
          }),
        });
        const result = await response.json() as { id?: string; error?: string };
        if (!response.ok || result.error) throw new Error(result.error || "進貨單保存失敗");
        persisted = true;
      }
      const createdAt = new Date();
      const deleteAfter = storagePath ? new Date(createdAt.getTime() + retentionDays * 86400000).toISOString() : undefined;
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
      const finalCharges: ReceiptCharge[] = analysis.charges.map((charge) => ({
        id: charge.id,
        chargeType: charge.chargeType,
        description: charge.description || undefined,
        amount: charge.amount,
      }));
      onConfirm({
        supplier: analysis.supplier,
        purchaseDate: analysis.purchaseDate,
        invoiceNumber: analysis.invoiceNumber,
        totalAmount: analysis.totalAmount,
        warnings: analysis.warnings,
        lines: finalLines,
        charges: finalCharges,
        id: generateId(),
        fileName: file?.name || "手動輸入進貨單",
        storagePath,
        status: "已入庫",
        createdAt: createdAt.toISOString(),
        deleteAfter,
        demo: !persisted,
      });
      resetEntry();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "入庫失敗");
    } finally {
      setBusy(false);
    }
  };

  // 金額試算：庫存品項小計＋運費＋其他費用＋稅額－折扣＝計算總額，只用來跟單據總額比對，不會自動修改任何數字。
  const { inventorySubtotal, shippingTotal, otherFeeTotal, taxTotal, discountTotal, calculatedTotal } = analysis
    ? calculateReceiptTotals(analysis.lines, analysis.charges)
    : { inventorySubtotal: 0, shippingTotal: 0, otherFeeTotal: 0, taxTotal: 0, discountTotal: 0, calculatedTotal: 0 };
  const amountMismatch = calculateAmountMismatch(analysis?.totalAmount, calculatedTotal);

  return <>
    <div className="section-header receipt-title"><div><h1>新增進貨單</h1><p>拍照AI辨識，或直接手動輸入，確認內容後一次完成入庫。</p></div><span className="privacy-badge"><ShieldCheck size={18} />私人照片 · 保存{retentionDays}天</span></div>
    <div className="receipt-layout">
      <section className="upload-card">
        <div className="mode-toggle">
          <button type="button" className={mode === "scan" ? "primary-button" : "secondary-button"} onClick={() => switchMode("scan")}><ScanLine size={16} />拍照辨識</button>
          <button type="button" className={mode === "manual" ? "primary-button" : "secondary-button"} onClick={() => switchMode("manual")}><FileImage size={16} />手動輸入</button>
        </div>
        {mode === "scan" ? <>
          <input ref={fileRef} hidden type="file" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} />
          {!preview ? <button className="upload-zone" onClick={() => fileRef.current?.click()}><span><Camera size={30} /></span><strong>拍照或上傳進貨單</strong><small>支援JPG、PNG；系統會先自動壓縮照片</small><em><Upload size={16} />選擇照片</em></button> : <div className="receipt-preview"><Image src={preview} alt="待辨識進貨單" fill unoptimized /><button aria-label="移除照片" title="移除照片" onClick={resetEntry}><X /></button></div>}
          {preview && !analysis && <button className="primary-button analyze-button" disabled={busy} onClick={analyze}>{busy ? <LoaderCircle className="spin" size={19} /> : <ScanLine size={19} />}{busy ? "AI辨識中…" : "開始辨識進貨單"}</button>}
        </> : <div className="manual-entry-prompt">
          <FileImage size={30} /><strong>手動輸入進貨單</strong><small>不需要照片，直接填寫供應商、品項與金額</small>
          {!analysis && <button className="primary-button analyze-button" onClick={startManualEntry}><Plus size={18} />開始手動輸入</button>}
        </div>}
        {error && <div className="error-box">{error}</div>}
      </section>

      <section className="analysis-card">
        {!analysis ? <div className="analysis-empty"><FileImage size={42} /><strong>{mode === "manual" ? "手動輸入的進貨單內容會顯示在這裡" : "辨識結果會顯示在這裡"}</strong><p>系統不會自動入庫，請先確認品項、數量與單位。</p></div> : <>
          <header><div><h2>{mode === "manual" ? "填寫進貨單內容" : "確認辨識結果"}</h2><p>{mode === "manual" ? "手動填寫供應商、品項與費用" : "可直接修改AI辨識錯誤的欄位"}</p></div><span>{analysis.lines.length}項庫存 · {analysis.charges.length}筆費用</span></header>
          <div className="receipt-meta"><label>供應商<input value={analysis.supplier} onChange={(e) => setAnalysis({ ...analysis, supplier: e.target.value })} /></label><label>進貨日期<input type="date" value={analysis.purchaseDate} onChange={(e) => setAnalysis({ ...analysis, purchaseDate: e.target.value })} /></label><label>單據號碼<input value={analysis.invoiceNumber || ""} onChange={(e) => setAnalysis({ ...analysis, invoiceNumber: e.target.value })} /></label><label>單據總額（必填）<input required type="number" min="0" step="0.01" value={analysis.totalAmount ?? ""} onChange={(e) => setAnalysis({ ...analysis, totalAmount: Number(e.target.value) || undefined })} /></label></div>
          {!hasTotalAmount && <div className="warning-box"><span>• 請填寫單據總額（必須大於0）才能完成入庫。</span></div>}
          {analysis.warnings.length > 0 && <div className="warning-box">{analysis.warnings.map((warning) => <span key={warning}>• {warning}</span>)}</div>}

          <div className="receipt-section-heading"><h3>庫存品項（{analysis.lines.length}）</h3><div className="receipt-section-actions"><button type="button" className="secondary-button" onClick={addExistingLine}><Plus size={14} />選擇現有品項</button><button type="button" className="secondary-button" onClick={addLine}><Plus size={14} />手動新增品項</button></div></div>
          {analysis.lines.length === 0 && <p className="receipt-section-empty">{mode === "manual" ? "還沒有品項，庫存裡已經有的品項請點「選擇現有品項」，新品項請點「手動新增品項」。" : "這張單據沒有辨識到庫存品項。"}</p>}
          <div className="receipt-lines">{analysis.lines.map((line) => <article key={line.id}>
            <button className="remove-line" aria-label="刪除品項" title="刪除品項" onClick={() => removeLine(line.id)}><X size={16} /></button>
            <label>品項名稱<input value={line.itemName} onChange={(e) => updateLine(line.id, { itemName: e.target.value })} /></label>
            {line.action === null && <ExistingItemPicker inventory={inventory} categories={categories} onUpdate={(patch) => updateLine(line.id, patch)} />}
            <div className="line-grid"><label>數量<input type="number" min="1" step="1" value={line.quantity} onChange={(e) => updateLine(line.id, { quantity: Math.round(Number(e.target.value)) })} /></label><label>單位<input value={line.unit} onChange={(e) => updateLine(line.id, { unit: e.target.value })} /></label><label>金額<input type="number" min="0" value={line.totalPrice || ""} onChange={(e) => updateLine(line.id, { totalPrice: Number(e.target.value) || undefined })} /></label></div>
            <ReceiptLineMatch line={line} inventory={inventory} categories={categories} onUpdate={(patch) => updateLine(line.id, patch)} onUpdateNewItem={(patch) => updateNewItem(line.id, patch)} />
            <button type="button" className="text-button line-switch-button" onClick={() => moveLineToCharge(line.id)}>這其實是運費／其他費用，不是庫存品項</button>
          </article>)}</div>
          {!allLinesResolved && <div className="warning-box"><span>• 還有品項尚未對應庫存，請先完成選擇（對應現有品項／建立新品項／忽略）再入庫。</span></div>}

          <div className="receipt-section-heading"><h3>其他費用（{analysis.charges.length}）</h3><button type="button" className="secondary-button" onClick={addCharge}><Plus size={14} />手動新增費用</button></div>
          <p className="receipt-section-note">運費、處理費、稅額、折扣等非庫存費用，確認入庫後只會保存在進貨單費用明細，不會建立庫存品項，也不會增加庫存數量。</p>
          {analysis.charges.length === 0 && <p className="receipt-section-empty">目前沒有其他費用。</p>}
          <div className="receipt-charges">{analysis.charges.map((charge) => <article key={charge.id} className="charge-row">
            <button className="remove-line" aria-label="刪除費用" title="刪除費用" onClick={() => removeCharge(charge.id)}><X size={16} /></button>
            <div className="form-grid">
              <label>費用類型<select value={charge.chargeType} onChange={(e) => updateCharge(charge.id, { chargeType: e.target.value as ReceiptChargeType })}>{CHARGE_TYPES.map((t) => <option key={t} value={t}>{CHARGE_TYPE_LABELS[t]}</option>)}</select></label>
              <label>金額<input type="number" min="0" step="0.01" value={charge.amount || ""} onChange={(e) => updateCharge(charge.id, { amount: Number(e.target.value) || 0 })} /></label>
            </div>
            <label>說明（可不填）<input value={charge.description} onChange={(e) => updateCharge(charge.id, { description: e.target.value })} placeholder="例如：宅配運費" /></label>
            <button type="button" className="text-button line-switch-button" onClick={() => moveChargeToLine(charge.id)}>這其實是庫存品項，不是費用</button>
          </article>)}</div>

          {Math.abs(amountMismatch) >= 1 && <div className="warning-box"><span>• 單據總額與試算總額不一致，差額 {formatCurrency(Math.abs(amountMismatch))}（{amountMismatch > 0 ? "單據較高" : "試算較高"}），系統不會自動調整數字，請確認金額無誤後再入庫。</span></div>}

          <div className="receipt-calc-card">
            <h3>金額試算</h3>
            <div className="receipt-calc-row"><span>庫存品項小計</span><span>{formatCurrency(inventorySubtotal)}</span></div>
            <div className="receipt-calc-row"><span>＋ 運費</span><span>{formatCurrency(shippingTotal)}</span></div>
            <div className="receipt-calc-row"><span>＋ 其他費用</span><span>{formatCurrency(otherFeeTotal)}</span></div>
            <div className="receipt-calc-row"><span>＋ 稅額</span><span>{formatCurrency(taxTotal)}</span></div>
            <div className="receipt-calc-row"><span>－ 折扣</span><span>{formatCurrency(discountTotal)}</span></div>
            <div className="receipt-calc-row receipt-calc-total"><span>＝ 計算總額</span><span>{formatCurrency(calculatedTotal)}</span></div>
          </div>

          <footer><div><small>單據總額</small><strong>{formatCurrency(analysis.totalAmount)}</strong></div><button className="primary-button" onClick={confirm} disabled={!hasAnyRow || busy || !allResolved} title={!hasTotalAmount ? "請先填寫單據總額" : undefined}>{busy ? "保存中…" : "確認並完成入庫"}</button></footer>
        </>}
      </section>
    </div>

    <section className="receipt-history"><h2>最近進貨單</h2>{receipts.length === 0 ? <p>尚無進貨單紀錄</p> : <div className="table-card"><table><thead><tr><th>上傳時間</th><th>供應商</th><th>檔案</th><th>品項</th><th>金額</th><th>照片保存至</th><th>狀態</th></tr></thead><tbody>{receipts.map((receipt) => <tr key={receipt.id}><td>{new Date(receipt.createdAt).toLocaleString("zh-TW")}</td><td>{receipt.supplier || "未辨識"}</td><td>{receipt.fileName}</td><td>{receipt.lines.length}項{(receipt.charges?.length ?? 0) > 0 ? `＋${receipt.charges.length}筆費用` : ""}</td><td>{formatCurrency(receipt.totalAmount)}</td><td>{receipt.deleteAfter ? new Date(receipt.deleteAfter).toLocaleDateString("zh-TW") : "—"}</td><td><span className="pill">{receipt.status}</span></td></tr>)}</tbody></table></div>}</section>
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
      <label>計算單位<input required value={line.newItem.unit} onChange={(e) => onUpdateNewItem({ unit: e.target.value })} /></label>
      <label>安全庫存<input type="number" min="0" step="1" value={line.newItem.safetyStock} onChange={(e) => onUpdateNewItem({ safetyStock: Math.round(Number(e.target.value)) })} /></label>
      <label className="check-label"><input type="checkbox" checked={line.newItem.usageForecastEnabled} onChange={(e) => onUpdateNewItem({ usageForecastEnabled: e.target.checked })} />啟用預估使用量</label>
      {line.newItem.usageForecastEnabled && <div className="form-grid">
        <label>預估使用量（{line.newItem.unit || "單位"}）<input required type="number" min="1" step="1" value={line.newItem.estimatedUsage} onChange={(e) => onUpdateNewItem({ estimatedUsage: Math.round(Number(e.target.value)) })} /></label>
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
    <div className="warning-box"><span>• 尚未對應庫存，請在上方選擇現有品項，或用以下其中一種方式處理。</span></div>
    {similar.length > 0 && <div className="line-match-similar">
      <small>相似的現有品項：</small>
      <div className="line-match-similar-list">{similar.map((item) => <button type="button" key={item.id} onClick={() => onUpdate({ action: "existing", selectedExistingId: item.id })}>{item.name}<small>現有{formatNumber(item.quantity)}{item.unit}</small></button>)}</div>
    </div>}
    <div className="line-match-actions">
      <button type="button" className="primary-button" onClick={() => onUpdate({ action: "create_new" })}><Plus size={15} />建立新庫存品項</button>
      <button type="button" className="secondary-button" onClick={() => onUpdate({ action: "ignore" })}>忽略此品項</button>
    </div>
  </div>;
}

// 選擇現有品項：先選大分類、再選品項，避免品項一多整個下拉選單很難找。這個元件被放在品項卡片最上方，
// 品項名稱下面、數量／單位／金額上面，讓「先挑品項」變成第一個動作，比原本埋在卡片下方直覺。
function ExistingItemPicker({ inventory, categories, onUpdate }: {
  inventory: InventoryItem[];
  categories: string[];
  onUpdate: (patch: Partial<WorkingLine>) => void;
}) {
  const [pickedCategory, setPickedCategory] = useState("");
  // 大分類清單要包含所有啟用中的分類（即使還沒有任何品項），也要包含現有品項實際用到的分類（含已停用的舊分類），
  // 不能只看inventory目前有哪些分類，不然像「廚房用品」「維修耗材」這種還沒建品項的分類會完全選不到。
  const inventoryCategories = Array.from(new Set([...categories, ...inventory.map((item) => item.category)])).sort();
  const itemsInPickedCategory = pickedCategory ? inventory.filter((item) => item.category === pickedCategory) : [];
  return <div className="form-grid existing-item-picker">
    <label>選擇現有品項：大分類<select value={pickedCategory} onChange={(e) => setPickedCategory(e.target.value)}><option value="">請選擇大分類…</option>{inventoryCategories.map((c) => <option key={c}>{c}</option>)}</select></label>
    <label>品項<select value="" disabled={!pickedCategory} onChange={(e) => { if (e.target.value) onUpdate({ action: "existing", selectedExistingId: e.target.value }); }}><option value="">{pickedCategory ? "請選擇現有品項…" : "請先選擇大分類"}</option>{itemsInPickedCategory.map((item) => <option key={item.id} value={item.id}>{item.name}（現有{formatNumber(item.quantity)}{item.unit}）</option>)}</select></label>
  </div>;
}
