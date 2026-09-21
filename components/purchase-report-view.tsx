"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Pencil, Trash2, TrendingDown, TrendingUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatNumber } from "@/lib/format";
import {
  formatCurrency, getTaipeiMonthStart, monthLabel, shiftMonth, shortMonthLabel,
  type PurchaseCategoryBreakdown, type PurchaseMonthlySummary, type PurchaseReportLine,
  type PurchaseSupplierBreakdown, type PurchaseTopItem, type PurchaseTrendPoint,
} from "@/lib/purchase-report";

// 米白／深綠色系配色，呼應介面既有的 --forest / --gold / --sage。
const CHART_COLORS = ["#153f35", "#c59c4d", "#5c8a72", "#a6763b", "#2f6353", "#8a6d3b", "#3f7864", "#c9a24d", "#6f5a3a", "#4f7e6c"];

interface ReportPayload {
  demo: boolean;
  month: string;
  summary: PurchaseMonthlySummary | null;
  trend: PurchaseTrendPoint[];
  categories: PurchaseCategoryBreakdown[];
  items: PurchaseTopItem[];
  suppliers: PurchaseSupplierBreakdown[];
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Record<string, unknown> }> }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  const label = (row.fullMonth as string) || (row.category as string) || (row.supplier as string) || (row.itemName as string) || "";
  const amount = row.totalAmount as number;
  return <div className="chart-tooltip"><strong>{label}</strong><span>{formatCurrency(amount)}</span></div>;
}

export function PurchaseReportView({ canView, canManage }: { canView: boolean; canManage: boolean }) {
  const [month, setMonth] = useState(() => getTaipeiMonthStart());
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState("");

  const [monthLines, setMonthLines] = useState<PurchaseReportLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(true);
  const [linesError, setLinesError] = useState("");

  const [categoryFilter, setCategoryFilter] = useState("全部");
  const [supplierFilter, setSupplierFilter] = useState("全部");
  const [keyword, setKeyword] = useState("");

  const [editingReceiptId, setEditingReceiptId] = useState<string | null>(null);
  const [deletingReceiptId, setDeletingReceiptId] = useState<string | null>(null);

  const loadReport = async (targetMonth: string) => {
    setReportLoading(true);
    setReportError("");
    try {
      const response = await fetch(`/api/purchase-report?month=${targetMonth}`);
      const data = await response.json() as ReportPayload & { error?: string };
      if (!response.ok) throw new Error(data.error || "讀取報表失敗");
      setReport(data);
    } catch (reason) {
      setReportError(reason instanceof Error ? reason.message : "讀取報表失敗，請稍後再試。");
    } finally {
      setReportLoading(false);
    }
  };

  const loadLines = async (targetMonth: string) => {
    setLinesLoading(true);
    setLinesError("");
    try {
      const response = await fetch(`/api/purchase-report/lines?month=${targetMonth}`);
      const data = await response.json() as { lines?: PurchaseReportLine[]; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取明細失敗");
      setMonthLines(data.lines || []);
    } catch (reason) {
      setLinesError(reason instanceof Error ? reason.message : "讀取明細失敗，請稍後再試。");
    } finally {
      setLinesLoading(false);
    }
  };

  const refresh = () => { loadReport(month); loadLines(month); };

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => { loadReport(month); loadLines(month); }, 0);
    return () => window.clearTimeout(timer);
  }, [canView, month]);

  const changeMonth = (nextMonth: string) => {
    setMonth(nextMonth);
    setCategoryFilter("全部");
    setSupplierFilter("全部");
    setKeyword("");
  };

  const filteredLines = useMemo(() => monthLines.filter((line) =>
    (categoryFilter === "全部" || line.category === categoryFilter) &&
    (supplierFilter === "全部" || (line.supplier || "未標示供應商") === supplierFilter) &&
    (!keyword.trim() || line.itemName.toLowerCase().includes(keyword.trim().toLowerCase())),
  ), [monthLines, categoryFilter, supplierFilter, keyword]);

  const categoryOptions = useMemo(() => Array.from(new Set(monthLines.map((l) => l.category))).sort(), [monthLines]);
  const supplierOptions = useMemo(() => Array.from(new Set(monthLines.map((l) => l.supplier || "未標示供應商"))).sort(), [monthLines]);
  const firstLineIdByReceipt = useMemo(() => {
    const seenReceipts = new Set<string>();
    const firstLineIds = new Set<string>();
    for (const line of filteredLines) {
      if (!seenReceipts.has(line.receiptId)) { seenReceipts.add(line.receiptId); firstLineIds.add(line.lineId); }
    }
    return firstLineIds;
  }, [filteredLines]);

  const editingReceiptLines = editingReceiptId ? monthLines.filter((l) => l.receiptId === editingReceiptId) : [];
  const deletingReceipt = deletingReceiptId ? monthLines.find((l) => l.receiptId === deletingReceiptId) : null;

  if (!canView) {
    return <><div className="section-header"><div><h1>進貨報表</h1><p>統計已確認入庫的進貨金額。</p></div></div>
      <div className="warning-box"><span>• 此頁面僅管理員與訂貨管家可以查看。</span></div>
    </>;
  }

  const summary = report?.summary ?? null;
  const monthDelta = summary ? summary.totalAmount - summary.prevMonthTotalAmount : 0;
  const monthDeltaPercent = summary && summary.prevMonthTotalAmount > 0
    ? (monthDelta / summary.prevMonthTotalAmount) * 100
    : null;
  const hasAnyData = Boolean(summary && (summary.receiptCount > 0 || (report?.categories.length ?? 0) > 0));

  return <>
    <div className="section-header">
      <div><h1>進貨報表</h1><p>只統計已確認入庫（status = stocked）的進貨單，月份以進貨日期（Asia/Taipei）為準。</p></div>
      <div className="report-month-picker">
        <button className="icon-button" aria-label="上一個月" title="上一個月" onClick={() => changeMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
        <input type="month" value={month.slice(0, 7)} onChange={(e) => { if (e.target.value) changeMonth(`${e.target.value}-01`); }} />
        <button className="icon-button" aria-label="下一個月" title="下一個月" onClick={() => changeMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
      </div>
    </div>

    {report?.demo && <div className="warning-box"><span>• 尚未設定Supabase，無法顯示進貨報表。</span></div>}
    {reportError && <div className="error-box">{reportError}</div>}

    {!report?.demo && !reportLoading && !reportError && !hasAnyData && <div className="report-empty-state"><AlertTriangle size={28} /><strong>{monthLabel(month)}尚無已入庫的進貨資料</strong><p>確認幾張進貨單入庫後，這裡就會自動顯示統計，不需要手動產生報表。</p></div>}

    {reportLoading ? <p>載入報表中…</p> : summary && hasAnyData && <>
      <div className="report-summary-grid">
        <div className="settings-card report-summary-card"><small>本月進貨總額</small><strong>{formatCurrency(summary.totalAmount)}</strong></div>
        <div className="settings-card report-summary-card"><small>本月進貨單數</small><strong>{formatNumber(summary.receiptCount)}張</strong></div>
        <div className="settings-card report-summary-card"><small>本月進貨品項數量</small><strong>{formatNumber(summary.itemCount)}筆</strong></div>
        <div className="settings-card report-summary-card"><small>最大支出分類</small><strong>{summary.topCategoryName || "—"}</strong><span>{formatCurrency(summary.topCategoryAmount)}</span></div>
        <div className="settings-card report-summary-card"><small>最大支出供應商</small><strong>{summary.topSupplierName || "—"}</strong><span>{formatCurrency(summary.topSupplierAmount)}</span></div>
        <div className="settings-card report-summary-card"><small>本月運費</small><strong>{formatCurrency(summary.shippingAmount)}</strong></div>
        <div className="settings-card report-summary-card"><small>本月其他費用</small><strong>{formatCurrency(summary.otherFeeAmount)}</strong><span>處理費／稅額／其他費用，已扣除折扣</span></div>
        <div className="settings-card report-summary-card">
          <small>與上月相比</small>
          <strong className={monthDelta > 0 ? "danger-text" : monthDelta < 0 ? "positive-text" : ""}>
            {monthDelta === 0 ? "持平" : <>{monthDelta > 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} {formatCurrency(Math.abs(monthDelta))}</>}
          </strong>
          <span>{monthDeltaPercent === null ? (summary.prevMonthTotalAmount === 0 && summary.totalAmount > 0 ? "上月無資料" : "") : `${monthDeltaPercent > 0 ? "+" : ""}${Math.round(monthDeltaPercent)}%`}</span>
        </div>
      </div>

      <div className="report-charts-grid">
        <section className="settings-card report-chart-card">
          <header><h2>最近12個月進貨金額</h2></header>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={(report?.trend ?? []).map((p) => ({ month: shortMonthLabel(p.month), fullMonth: monthLabel(p.month), totalAmount: p.totalAmount }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8e2d5" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#71807b" }} axisLine={{ stroke: "#e8e2d5" }} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: "#71807b" }} axisLine={false} tickLine={false} tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f4f0e7" }} />
              <Bar dataKey="totalAmount" fill="#153f35" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="settings-card report-chart-card">
          <header><h2>當月各大分類支出</h2></header>
          {(report?.categories.length ?? 0) === 0 ? <p className="report-chart-empty">本月尚無分類統計資料</p> : <>
            <ResponsiveContainer width="100%" height={Math.max(180, (report?.categories.length ?? 0) * 40)}>
              <BarChart data={report?.categories} layout="vertical" margin={{ left: 8, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e8e2d5" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12, fill: "#71807b" }} axisLine={false} tickLine={false} tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
                <YAxis type="category" dataKey="category" width={96} tick={{ fontSize: 12, fill: "#20332e" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f4f0e7" }} />
                <Bar dataKey="totalAmount" radius={[0, 6, 6, 0]}>
                  {(report?.categories ?? []).map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {(report?.categories ?? []).some((c) => c.incompleteLineCount > 0) && <p className="report-chart-note">• 部分品項金額資料不完整，未計入分類統計（詳見下方明細）。</p>}
          </>}
        </section>

        <section className="settings-card report-chart-card">
          <header><h2>當月前10名進貨品項</h2></header>
          {(report?.items.length ?? 0) === 0 ? <p className="report-chart-empty">本月尚無品項統計資料</p> : <ol className="report-rank-list">{report?.items.map((item, index) => <li key={item.itemName}><span className="report-rank-index">{index + 1}</span><span className="report-rank-name">{item.itemName}<small>{formatNumber(item.totalQuantity)} {item.unit}</small></span><strong>{formatCurrency(item.totalAmount)}</strong></li>)}</ol>}
        </section>

        <section className="settings-card report-chart-card">
          <header><h2>當月各供應商支出</h2></header>
          {(report?.suppliers.length ?? 0) === 0 ? <p className="report-chart-empty">本月尚無供應商統計資料</p> : <ol className="report-rank-list">{report?.suppliers.map((s, index) => <li key={s.supplier}><span className="report-rank-index">{index + 1}</span><span className="report-rank-name">{s.supplier}<small>{s.receiptCount}張進貨單</small></span><strong>{formatCurrency(s.totalAmount)}</strong></li>)}</ol>}
        </section>
      </div>
    </>}

    <div className="section-header"><div><h1 className="report-detail-title">進貨明細</h1></div></div>
    <div className="toolbar">
      <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option>全部</option>{categoryOptions.map((c) => <option key={c}>{c}</option>)}</select>
      <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}><option>全部</option>{supplierOptions.map((s) => <option key={s}>{s}</option>)}</select>
      <div className="search-box"><input placeholder="搜尋品項關鍵字" value={keyword} onChange={(e) => setKeyword(e.target.value)} /></div>
    </div>
    {linesError && <div className="error-box">{linesError}</div>}
    {linesLoading ? <p>載入明細中…</p> : filteredLines.length === 0 ? <div className="report-empty-state"><AlertTriangle size={28} /><strong>沒有符合條件的明細</strong><p>請調整月份或篩選條件。</p></div> : <div className="table-card"><table><thead><tr><th>進貨日期</th><th>供應商</th><th>單據號碼</th><th>品項名稱</th><th>大分類</th><th>數量</th><th>單價</th><th>品項金額</th><th>單據狀態</th><th>操作</th></tr></thead><tbody>{filteredLines.map((line) => {
      const showReceiptActions = firstLineIdByReceipt.has(line.lineId);
      return <tr key={line.lineId}>
        <td>{line.purchaseDate || "—"}</td>
        <td>{line.supplier || "未標示供應商"}</td>
        <td>{line.invoiceNumber || "—"}</td>
        <td>{line.itemName}</td>
        <td>{line.category}</td>
        <td>{formatNumber(line.quantity)} {line.unit}</td>
        <td>{line.unitPrice !== null ? formatCurrency(line.unitPrice) : "—"}</td>
        <td>{line.effectiveAmount !== null ? formatCurrency(line.effectiveAmount) : <span className="danger-text">金額資料不完整</span>}</td>
        <td><span className="pill">已入庫</span></td>
        <td>{showReceiptActions && canManage && <div className="row-actions"><button aria-label="編輯金額" title="編輯金額" onClick={() => setEditingReceiptId(line.receiptId)}><Pencil size={15} /></button><button className="danger" aria-label="刪除進貨單" title="刪除進貨單" onClick={() => setDeletingReceiptId(line.receiptId)}><Trash2 size={15} /></button></div>}</td>
      </tr>;
    })}</tbody></table></div>}

    {editingReceiptId && editingReceiptLines.length > 0 && <EditReceiptAmountsModal
      receiptId={editingReceiptId}
      lines={editingReceiptLines}
      onClose={() => setEditingReceiptId(null)}
      onSaved={() => { setEditingReceiptId(null); refresh(); }}
    />}
    {deletingReceiptId && deletingReceipt && <ConfirmDeleteReceiptModal
      receiptId={deletingReceiptId}
      supplier={deletingReceipt.supplier}
      purchaseDate={deletingReceipt.purchaseDate}
      onClose={() => setDeletingReceiptId(null)}
      onDeleted={() => { setDeletingReceiptId(null); refresh(); }}
    />}
  </>;
}

function EditReceiptAmountsModal({ receiptId, lines, onClose, onSaved }: {
  receiptId: string;
  lines: PurchaseReportLine[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [totalAmount, setTotalAmount] = useState<string>(lines[0]?.receiptTotalAmount !== null && lines[0]?.receiptTotalAmount !== undefined ? String(lines[0].receiptTotalAmount) : "");
  const [lineEdits, setLineEdits] = useState<Record<string, { unitPrice: string; totalPrice: string }>>(() => {
    const initial: Record<string, { unitPrice: string; totalPrice: string }> = {};
    for (const line of lines) {
      initial[line.lineId] = {
        unitPrice: line.unitPrice !== null ? String(line.unitPrice) : "",
        totalPrice: line.totalPrice !== null ? String(line.totalPrice) : "",
      };
    }
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedTotal = totalAmount.trim() === "" ? null : Number(totalAmount);
    if (parsedTotal !== null && (!Number.isFinite(parsedTotal) || parsedTotal < 0)) { setError("單據總額必須是不小於0的數字。"); return; }
    const lineUpdates: Array<{ id: string; unitPrice: number | null; totalPrice: number | null }> = [];
    for (const line of lines) {
      const edit = lineEdits[line.lineId];
      const unitPrice = edit.unitPrice.trim() === "" ? null : Number(edit.unitPrice);
      const totalPrice = edit.totalPrice.trim() === "" ? null : Number(edit.totalPrice);
      if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) { setError(`「${line.itemName}」單價必須是不小於0的數字。`); return; }
      if (totalPrice !== null && (!Number.isFinite(totalPrice) || totalPrice < 0)) { setError(`「${line.itemName}」金額必須是不小於0的數字。`); return; }
      lineUpdates.push({ id: line.lineId, unitPrice, totalPrice });
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/receipts/${receiptId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalAmount: parsedTotal, lines: lineUpdates }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "更新失敗");
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal report-edit-modal">
    <header><div><h2>編輯進貨單金額</h2><p>{lines[0]?.supplier || "未標示供應商"} · {lines[0]?.purchaseDate || "—"}</p></div><button onClick={onClose} aria-label="關閉" title="關閉"><X /></button></header>
    <form onSubmit={submit}>
      <label>單據總額（留白表示以品項金額加總計算）<input type="number" min="0" step="0.01" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} placeholder="例如：1250" /></label>
      <div className="report-edit-lines">{lines.map((line) => <div key={line.lineId} className="report-edit-line">
        <strong>{line.itemName}</strong><small>{formatNumber(line.quantity)} {line.unit}</small>
        <div className="form-grid">
          <label>單價<input type="number" min="0" step="0.01" value={lineEdits[line.lineId]?.unitPrice ?? ""} onChange={(e) => setLineEdits({ ...lineEdits, [line.lineId]: { ...lineEdits[line.lineId], unitPrice: e.target.value } })} /></label>
          <label>品項金額<input type="number" min="0" step="0.01" value={lineEdits[line.lineId]?.totalPrice ?? ""} onChange={(e) => setLineEdits({ ...lineEdits, [line.lineId]: { ...lineEdits[line.lineId], totalPrice: e.target.value } })} /></label>
        </div>
      </div>)}</div>
      {error && <div className="error-box">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting}>{submitting ? "儲存中…" : "儲存變更"}</button></div>
    </form>
  </div></div>;
}

function ConfirmDeleteReceiptModal({ receiptId, supplier, purchaseDate, onClose, onDeleted }: {
  receiptId: string;
  supplier: string | null;
  purchaseDate: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const confirmDelete = async () => {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/receipts/${receiptId}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "刪除失敗");
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刪除失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal">
    <header><div><h2>刪除進貨單</h2><p>此操作無法復原，報表將不再計入這筆資料</p></div><button onClick={onClose} aria-label="關閉" title="關閉"><X /></button></header>
    <div className="modal-body">
      <p>確定要刪除 <strong>{supplier || "未標示供應商"}</strong>（{purchaseDate || "日期未知"}）這張已入庫的進貨單嗎？連同其所有品項明細一併刪除。</p>
      {error && <div className="error-box">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" onClick={confirmDelete} disabled={submitting}>{submitting ? "刪除中…" : "確定刪除"}</button></div>
    </div>
  </div></div>;
}
