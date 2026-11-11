"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Download, RefreshCw, Search, TrendingDown, TrendingUp, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { downloadTextFile } from "@/lib/csv";
import { formatNumber } from "@/lib/format";
import {
  formatCurrency, getTaipeiMonthStart, monthLabel, purchaseLinesToCsv, shiftMonth, shortMonthLabel, sortReportLines, summarizeLines,
  type LineSortKey, type PurchaseCategoryBreakdown, type PurchaseMonthlySummary, type PurchaseReportLine,
  type PurchaseSupplierBreakdown, type PurchaseTopItem, type PurchaseTrendPoint, type SortDir,
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

type DeletedReceipt = { id: string; supplier: string | null; purchaseDate: string | null; invoiceNumber: string | null; amount: number; lineCount: number; deletedAt: string | null };
type ReportNotice = { message: string; error?: boolean; restoreReceiptId?: string };

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Record<string, unknown> }> }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  const label = (row.fullMonth as string) || (row.category as string) || (row.supplier as string) || (row.itemName as string) || "";
  const amount = row.totalAmount as number;
  return <div className="chart-tooltip"><strong>{label}</strong><span>{formatCurrency(amount)}</span></div>;
}

export function PurchaseReportView({ canView, canManage }: { canView: boolean; canManage: boolean }) {
  const currentMonth = getTaipeiMonthStart();
  const [month, setMonth] = useState(currentMonth);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState("");

  const [monthLines, setMonthLines] = useState<PurchaseReportLine[]>([]);
  const [linesLoaded, setLinesLoaded] = useState(false);
  const [linesLoading, setLinesLoading] = useState(true);
  const [linesError, setLinesError] = useState("");

  const [categoryFilter, setCategoryFilter] = useState("全部");
  const [supplierFilter, setSupplierFilter] = useState("全部");
  const [keyword, setKeyword] = useState("");
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [sort, setSort] = useState<{ key: LineSortKey; dir: SortDir }>({ key: "date", dir: "desc" });

  const [editingReceiptId, setEditingReceiptId] = useState<string | null>(null);
  const [deletingReceiptId, setDeletingReceiptId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReportNotice | null>(null);
  const [restoring, setRestoring] = useState(false);

  // 連續切換月份時，只採用「最後一次」請求的結果，晚回來的舊月份資料不會蓋掉新月份。
  const reportSeq = useRef(0);
  const linesSeq = useRef(0);
  // 操作（復原、改金額…）要花一點時間，期間使用者可能已經換月份；完成後刷新的要是「現在選的月份」。
  const monthRef = useRef(month);
  useEffect(() => { monthRef.current = month; }, [month]);
  const [linesMonth, setLinesMonth] = useState("");
  const [deletedReceipts, setDeletedReceipts] = useState<DeletedReceipt[]>([]);
  const [deletedError, setDeletedError] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadReport = async (targetMonth: string) => {
    const mine = ++reportSeq.current;
    setReportLoading(true);
    setReportError("");
    try {
      const response = await fetch(`/api/purchase-report?month=${targetMonth}`);
      const data = await response.json() as ReportPayload & { error?: string };
      if (mine !== reportSeq.current) return;
      if (!response.ok) throw new Error(data.error || "讀取報表失敗");
      setReport(data);
    } catch (reason) {
      if (mine !== reportSeq.current) return;
      setReport(null);
      setReportError(reason instanceof Error ? reason.message : "讀取報表失敗，請稍後再試。");
    } finally {
      if (mine === reportSeq.current) setReportLoading(false);
    }
  };

  const loadLines = async (targetMonth: string) => {
    const mine = ++linesSeq.current;
    setLinesLoading(true);
    setLinesError("");
    try {
      const response = await fetch(`/api/purchase-report/lines?month=${targetMonth}`);
      const data = await response.json() as { lines?: PurchaseReportLine[]; error?: string };
      if (mine !== linesSeq.current) return;
      if (!response.ok) throw new Error(data.error || "讀取明細失敗");
      setMonthLines(data.lines || []);
      setLinesLoaded(true);
      setLinesMonth(targetMonth);
    } catch (reason) {
      if (mine !== linesSeq.current) return;
      setMonthLines([]);
      setLinesMonth("");
      setLinesError(reason instanceof Error ? reason.message : "讀取明細失敗，請稍後再試。");
    } finally {
      if (mine === linesSeq.current) setLinesLoading(false);
    }
  };

  const loadDeleted = async () => {
    if (!canManage) return;
    try {
      const response = await fetch("/api/receipts/deleted");
      const data = await response.json() as { receipts?: DeletedReceipt[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取已刪除的進貨單失敗");
      setDeletedReceipts(data.receipts || []);
      setDeletedError("");
    } catch (reason) {
      setDeletedError(reason instanceof Error ? reason.message : "讀取已刪除的進貨單失敗，請稍後再試。");
    }
  };

  const refresh = () => { loadReport(monthRef.current); loadLines(monthRef.current); loadDeleted(); };

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => { loadReport(month); loadLines(month); }, 0);
    return () => window.clearTimeout(timer);
  }, [canView, month]);

  useEffect(() => {
    if (!canView || !canManage) return;
    const timer = window.setTimeout(() => { loadDeleted(); }, 0);
    return () => window.clearTimeout(timer);
    // loadDeleted 每次渲染都是新函式，只在權限變化時載入一次（之後由 refresh 負責更新）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, canManage]);

  const changeMonth = (nextMonth: string) => {
    setMonth(nextMonth);
    setCategoryFilter("全部");
    setSupplierFilter("全部");
    setKeyword("");
    setOnlyIncomplete(false);
    setNotice(null);
  };

  const incompleteCount = useMemo(() => monthLines.filter((l) => l.effectiveAmount === null).length, [monthLines]);
  const hasFilter = categoryFilter !== "全部" || supplierFilter !== "全部" || keyword.trim() !== "" || onlyIncomplete;
  const clearFilters = () => { setCategoryFilter("全部"); setSupplierFilter("全部"); setKeyword(""); setOnlyIncomplete(false); };

  const filteredLines = useMemo(() => sortReportLines(monthLines.filter((line) =>
    (categoryFilter === "全部" || line.category === categoryFilter) &&
    (supplierFilter === "全部" || (line.supplier || "未標示供應商") === supplierFilter) &&
    (!keyword.trim() || line.itemName.toLowerCase().includes(keyword.trim().toLowerCase())) &&
    (!onlyIncomplete || line.effectiveAmount === null),
  ), sort.key, sort.dir), [monthLines, categoryFilter, supplierFilter, keyword, onlyIncomplete, sort]);

  const subtotal = useMemo(() => summarizeLines(filteredLines), [filteredLines]);
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
  const deletingReceiptLines = deletingReceiptId ? monthLines.filter((l) => l.receiptId === deletingReceiptId) : [];

  const toggleSort = (key: LineSortKey) => setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "item" ? "asc" : "desc" });
  const sortMark = (key: LineSortKey) => sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  const ariaSort = (key: LineSortKey): "ascending" | "descending" | "none" => sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none";

  const exportCsv = () => {
    downloadTextFile(`進貨明細_${linesMonth.slice(0, 7)}.csv`, purchaseLinesToCsv(filteredLines));
    setNotice({ message: `已匯出 ${filteredLines.length} 筆明細${hasFilter ? "（依目前的篩選與排序）" : ""}。` });
  };

  const restoreReceipt = async (receiptId: string) => {
    setRestoring(true);
    setRestoringId(receiptId);
    try {
      const response = await fetch(`/api/receipts/${receiptId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore" }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "復原失敗");
      setNotice({ message: "已復原這張進貨單，報表重新計入。" });
      refresh();
    } catch (reason) {
      setNotice({ message: `復原失敗：${reason instanceof Error ? reason.message : "請稍後再試。"}`, error: true, restoreReceiptId: receiptId });
    } finally {
      setRestoring(false);
      setRestoringId(null);
    }
  };
  const undoDelete = async () => { if (notice?.restoreReceiptId) await restoreReceipt(notice.restoreReceiptId); };

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
  const isCurrentMonth = month === currentMonth;
  const showDetail = monthLines.length > 0 || linesLoading || Boolean(linesError);

  return <>
    <div className="section-header">
      <div><h1>進貨報表</h1><p>統計已確認入庫的進貨單，月份以進貨日期為準。</p></div>
      <div className="report-month-picker">
        <button className="icon-button" aria-label="上一個月" title="上一個月" onClick={() => changeMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
        <input type="month" value={month.slice(0, 7)} aria-label="選擇月份" onChange={(e) => { if (e.target.value) changeMonth(`${e.target.value}-01`); }} />
        <button className="icon-button" aria-label="下一個月" title="下一個月" onClick={() => changeMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
        {!isCurrentMonth && <button type="button" className="secondary-button" onClick={() => changeMonth(currentMonth)}>回到本月</button>}
      </div>
    </div>

    <details className="movement-help"><summary>金額怎麼算</summary>
      <ul className="report-help-list">
        <li>進貨總額＝每張進貨單的「單據總額」加總；沒填單據總額的，用品項金額加總。</li>
        <li>品項缺金額或單價的，不會算進分類與品項統計，明細裡會標「金額資料不完整」。</li>
        <li>運費、其他費用（處理費／稅額）已扣除折扣，另外列在摘要裡。</li>
      </ul>
    </details>

    {report?.demo && <div className="warning-box"><span>• 尚未設定Supabase，無法顯示進貨報表。</span></div>}
    {notice && <div className={notice.error ? "error-box inventory-notice" : "inventory-notice"} role={notice.error ? "alert" : "status"}>
      <span>{notice.message}</span>
      {notice.restoreReceiptId && <button type="button" className="text-button" onClick={undoDelete} disabled={restoring}><Undo2 size={14} />{restoring ? "復原中…" : notice.error ? "再試一次" : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setNotice(null)}><X size={14} /></button>
    </div>}
    {reportError && <div className="error-box inventory-notice" role="alert"><span>{reportError}</span><button type="button" className="text-button" onClick={() => loadReport(month)}><RefreshCw size={14} />重新載入</button></div>}

    {!report?.demo && !reportLoading && !reportError && !hasAnyData && <div className="report-empty-state"><AlertTriangle size={28} /><strong>{monthLabel(month)}尚無已入庫的進貨資料</strong><p>確認幾張進貨單入庫後，這裡就會自動顯示統計，不需要手動產生報表。</p></div>}

    {!summary && reportLoading && !reportError && <p className="panel-empty">載入報表中…</p>}
    {summary && hasAnyData && <div className={reportLoading ? "report-body is-refreshing" : "report-body"} aria-busy={reportLoading}>
      <h2 className="report-month-title">{monthLabel(month)}摘要{reportLoading && <small>更新中…</small>}</h2>
      {incompleteCount > 0 && <div className="warning-box report-incomplete" role="status">
        <span>• 有 <b>{incompleteCount}</b> 個品項的金額資料不完整，沒有算進分類與品項統計。{canManage ? "到下方明細按「編輯金額」補上。" : "請管理員補上金額。"}</span>
        <button type="button" className="text-button" onClick={() => { setOnlyIncomplete(true); document.getElementById("report-detail")?.scrollIntoView({ behavior: "smooth" }); }}>只看這些</button>
      </div>}
      <div className="report-summary-grid">
        <div className="settings-card report-summary-card is-primary">
          <small>進貨總額</small>
          <strong>{formatCurrency(summary.totalAmount)}</strong>
          <span className={monthDelta > 0 ? "danger-text" : monthDelta < 0 ? "positive-text" : ""}>
            {monthDelta === 0 ? "和上個月一樣" : <>{monthDelta > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />} 比上個月{monthDelta > 0 ? "多" : "少"} {formatCurrency(Math.abs(monthDelta))}{monthDeltaPercent !== null && `（${monthDeltaPercent > 0 ? "+" : ""}${Math.round(monthDeltaPercent)}%）`}{summary.prevMonthTotalAmount === 0 && "（上個月沒有資料）"}</>}
          </span>
        </div>
        <div className="settings-card report-summary-card"><small>進貨單數</small><strong>{formatNumber(summary.receiptCount)}張</strong></div>
        <div className="settings-card report-summary-card"><small>進貨品項筆數</small><strong>{formatNumber(summary.itemCount)}筆</strong><span>進貨單上的品項行數</span></div>
        <div className="settings-card report-summary-card"><small>最大支出分類</small><strong>{summary.topCategoryName || "—"}</strong><span>{formatCurrency(summary.topCategoryAmount)}</span></div>
        <div className="settings-card report-summary-card"><small>最大支出供應商</small><strong>{summary.topSupplierName || "—"}</strong><span>{formatCurrency(summary.topSupplierAmount)}</span></div>
        <div className="settings-card report-summary-card"><small>運費</small><strong>{formatCurrency(summary.shippingAmount)}</strong></div>
        <div className="settings-card report-summary-card"><small>其他費用</small><strong>{formatCurrency(summary.otherFeeAmount)}</strong><span>處理費／稅額／其他，已扣除折扣</span></div>
      </div>

      <div className="report-charts-grid">
        <section className="settings-card report-chart-card">
          <header><h2>最近12個月進貨金額</h2></header>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={(report?.trend ?? []).map((p) => ({ month: shortMonthLabel(p.month), fullMonth: monthLabel(p.month), totalAmount: p.totalAmount }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8e2d5" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#5c6b66" }} axisLine={{ stroke: "#e8e2d5" }} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: "#5c6b66" }} axisLine={false} tickLine={false} tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f4f0e7" }} />
              <Bar dataKey="totalAmount" fill="#153f35" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="settings-card report-chart-card">
          <header><h2>當月各大分類支出</h2></header>
          {(report?.categories.length ?? 0) === 0 ? <p className="report-chart-empty">這個月尚無分類統計資料</p> : <>
            <ResponsiveContainer width="100%" height={Math.max(180, (report?.categories.length ?? 0) * 40)}>
              <BarChart data={report?.categories} layout="vertical" margin={{ left: 8, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e8e2d5" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12, fill: "#5c6b66" }} axisLine={false} tickLine={false} tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
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
          {(report?.items.length ?? 0) === 0 ? <p className="report-chart-empty">這個月尚無品項統計資料</p> : <ol className="report-rank-list">{report?.items.map((item, index) => <li key={item.itemName}><span className="report-rank-index">{index + 1}</span><span className="report-rank-name">{item.itemName}<small>{formatNumber(item.totalQuantity)} {item.unit}</small></span><strong>{formatCurrency(item.totalAmount)}</strong></li>)}</ol>}
        </section>

        <section className="settings-card report-chart-card">
          <header><h2>當月各供應商支出</h2></header>
          {(report?.suppliers.length ?? 0) === 0 ? <p className="report-chart-empty">這個月尚無供應商統計資料</p> : <ol className="report-rank-list">{report?.suppliers.map((s, index) => <li key={s.supplier}><span className="report-rank-index">{index + 1}</span><span className="report-rank-name">{s.supplier}<small>{s.receiptCount}張進貨單</small></span><strong>{formatCurrency(s.totalAmount)}</strong></li>)}</ol>}
        </section>
      </div>
    </div>}

    {showDetail && <section id="report-detail">
      <div className="section-header report-detail-header">
        <div><h1 className="report-detail-title">進貨明細</h1><p>{monthLabel(month)}已入庫的進貨單，每個品項一列。</p></div>
        <button type="button" className="secondary-button" onClick={exportCsv} disabled={filteredLines.length === 0 || linesLoading || linesMonth !== month} title={linesLoading || linesMonth !== month ? "明細還在載入，載入完成後才能匯出" : undefined}><Download size={16} />匯出 CSV</button>
      </div>
      {linesError && <div className="error-box inventory-notice" role="alert"><span>{linesError}</span><button type="button" className="text-button" onClick={() => loadLines(month)}><RefreshCw size={14} />重新載入</button></div>}
      {monthLines.length > 0 && <>
        <div className="toolbar report-toolbar">
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="依大分類篩選"><option value="全部">全部大分類</option>{categoryOptions.map((c) => <option key={c}>{c}</option>)}</select>
          <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} aria-label="依供應商篩選"><option value="全部">全部供應商</option>{supplierOptions.map((s) => <option key={s}>{s}</option>)}</select>
          <div className="search-box"><Search size={18} /><input placeholder="搜尋品項名稱" value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="搜尋品項名稱" /></div>
          {incompleteCount > 0 && <label className="inline-check"><input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} />只看金額不完整（{incompleteCount}）</label>}
          {hasFilter && <button type="button" className="text-button" onClick={clearFilters}><X size={14} />清除篩選</button>}
        </div>
        <div className="movement-summary" aria-live="polite">
          <span>共 <b>{subtotal.lineCount}</b> 個品項、{subtotal.receiptCount} 張進貨單，品項金額合計 <b>{formatCurrency(subtotal.amount)}</b>{subtotal.incompleteCount > 0 && <span className="field-hint">　（{subtotal.incompleteCount} 個金額不完整的不計）</span>}</span>
        </div>
      </>}
      {linesLoading && !linesLoaded ? <p className="panel-empty">載入明細中…</p>
        : filteredLines.length === 0 && monthLines.length > 0 ? <div className="report-empty-state"><AlertTriangle size={28} /><strong>沒有符合條件的明細</strong><p>請調整篩選條件。</p><button type="button" className="secondary-button" onClick={clearFilters}>清除篩選</button></div>
        : filteredLines.length > 0 && <div className={linesLoading ? "table-card is-refreshing" : "table-card"} aria-busy={linesLoading}><table className="report-lines-table"><thead><tr>
          <th aria-sort={ariaSort("date")}><button type="button" className="sort-button" onClick={() => toggleSort("date")}>進貨日期{sortMark("date")}</button></th>
          <th>供應商</th><th>單據號碼</th>
          <th aria-sort={ariaSort("item")}><button type="button" className="sort-button" onClick={() => toggleSort("item")}>品項名稱{sortMark("item")}</button></th>
          <th>大分類</th><th>數量</th><th>單價</th>
          <th aria-sort={ariaSort("amount")}><button type="button" className="sort-button" onClick={() => toggleSort("amount")}>品項金額{sortMark("amount")}</button></th>
          {canManage && <th>單據操作</th>}
        </tr></thead><tbody>{filteredLines.map((line) => {
          const showReceiptActions = firstLineIdByReceipt.has(line.lineId);
          return <tr key={line.lineId}>
            <td data-label="進貨日期">{line.purchaseDate || "—"}</td>
            <td data-label="供應商">{line.supplier || "未標示供應商"}</td>
            <td data-label="單據號碼">{line.invoiceNumber || "—"}</td>
            <td data-label="品項名稱"><strong>{line.itemName}</strong></td>
            <td data-label="大分類">{line.category}</td>
            <td data-label="數量">{formatNumber(line.quantity)} {line.unit}</td>
            <td data-label="單價">{line.unitPrice !== null ? formatCurrency(line.unitPrice) : "—"}</td>
            <td data-label="品項金額">{line.effectiveAmount !== null ? formatCurrency(line.effectiveAmount) : <span className="danger-text">金額資料不完整</span>}</td>
            {canManage && <td data-label="單據操作">{showReceiptActions && <div className="row-actions"><button type="button" className="row-text-button" title="修改這張進貨單的單據總額與品項金額" onClick={() => setEditingReceiptId(line.receiptId)}>編輯金額</button><button type="button" className="row-text-button danger-text-button" title="刪除這張進貨單（可以馬上復原）" onClick={() => setDeletingReceiptId(line.receiptId)}>刪除</button></div>}</td>}
          </tr>;
        })}</tbody></table></div>}
    </section>}

    {canManage && (deletedReceipts.length > 0 || deletedError) && <details className="movement-help report-deleted">
      <summary>最近刪除的進貨單（{deletedReceipts.length}）</summary>
      {deletedError && <div className="error-box" role="alert">{deletedError}</div>}
      <ul className="report-deleted-list">{deletedReceipts.map((r) => <li key={r.id}>
        <span><strong>{r.supplier || "未標示供應商"}　{r.purchaseDate || "日期未知"}</strong><small>{r.lineCount} 個品項　{formatCurrency(r.amount)}{r.invoiceNumber ? `　單據 ${r.invoiceNumber}` : ""}{r.deletedAt ? `　刪除於 ${new Date(r.deletedAt).toLocaleDateString("zh-TW")}` : ""}</small></span>
        <button type="button" className="row-text-button" disabled={restoring} onClick={() => restoreReceipt(r.id)}><Undo2 size={14} />{restoringId === r.id ? "復原中…" : "復原"}</button>
      </li>)}</ul>
      <p className="field-hint">復原後這張單會重新計入報表。刪除和復原都不會動庫存數量。</p>
    </details>}

    {editingReceiptId && editingReceiptLines.length > 0 && <EditReceiptAmountsModal
      receiptId={editingReceiptId}
      lines={editingReceiptLines}
      onClose={() => setEditingReceiptId(null)}
      onSaved={() => { setEditingReceiptId(null); setNotice({ message: "已儲存金額修改，報表已更新。" }); refresh(); }}
    />}
    {deletingReceiptId && deletingReceiptLines.length > 0 && <ConfirmDeleteReceiptModal
      receiptId={deletingReceiptId}
      lines={deletingReceiptLines}
      onClose={() => setDeletingReceiptId(null)}
      onDeleted={() => {
        const first = deletingReceiptLines[0];
        setNotice({ message: `已刪除「${first.supplier || "未標示供應商"}（${first.purchaseDate || "日期未知"}）」這張進貨單，報表不再計入；庫存數量沒有退回。`, restoreReceiptId: deletingReceiptId });
        setDeletingReceiptId(null);
        refresh();
      }}
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
  const lineSum = lines.reduce((sum, line) => sum + (Number(lineEdits[line.lineId]?.totalPrice) || 0), 0);
  const typedTotal = totalAmount.trim() === "" ? null : Number(totalAmount);
  const totalDiffers = typedTotal !== null && Number.isFinite(typedTotal) && Math.abs(typedTotal - lineSum) >= 0.5;

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

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}><div className="modal report-edit-modal">
    <header><div><h2>編輯進貨單金額</h2><p>{lines[0]?.supplier || "未標示供應商"} · {lines[0]?.purchaseDate || "—"}</p></div><button onClick={onClose} disabled={submitting} aria-label="關閉" title="關閉"><X /></button></header>
    <form onSubmit={submit}>
      <label>單據總額（留白表示以品項金額加總計算）<input type="number" min="0" step="0.01" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} placeholder="例如：1250" autoFocus /></label>
      <p className="field-hint">品項金額加總：<b>{formatCurrency(lineSum)}</b>{totalDiffers && <span className="danger-text">　和單據總額不同；差額可能是運費、折扣或其他費用，確認無誤再儲存。</span>}</p>
      <div className="report-edit-lines">{lines.map((line) => <div key={line.lineId} className="report-edit-line">
        <strong>{line.itemName}</strong><small>{formatNumber(line.quantity)} {line.unit}</small>
        <div className="form-grid">
          <label>單價<input type="number" min="0" step="0.01" value={lineEdits[line.lineId]?.unitPrice ?? ""} onChange={(e) => setLineEdits({ ...lineEdits, [line.lineId]: { ...lineEdits[line.lineId], unitPrice: e.target.value } })} /></label>
          <label>品項金額<input type="number" min="0" step="0.01" value={lineEdits[line.lineId]?.totalPrice ?? ""} onChange={(e) => setLineEdits({ ...lineEdits, [line.lineId]: { ...lineEdits[line.lineId], totalPrice: e.target.value } })} /></label>
        </div>
      </div>)}</div>
      {error && <div className="error-box">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>取消</button><button className="primary-button" disabled={submitting}>{submitting ? "儲存中…" : "儲存變更"}</button></div>
    </form>
  </div></div>;
}

function ConfirmDeleteReceiptModal({ receiptId, lines, onClose, onDeleted }: {
  receiptId: string;
  lines: PurchaseReportLine[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [understood, setUnderstood] = useState(false);
  const first = lines[0];
  const amount = first.receiptTotalAmount ?? summarizeLines(lines).amount;

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

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}><div className="modal">
    <header><div><h2>刪除進貨單</h2><p>刪除後這張單不再計入報表，可以馬上復原</p></div><button onClick={onClose} disabled={submitting} aria-label="關閉" title="關閉"><X /></button></header>
    <div className="modal-body">
      <div className="note-delete-preview">
        <strong>{first.supplier || "未標示供應商"}　{first.purchaseDate || "日期未知"}</strong>
        <small>{lines.length} 個品項　{formatCurrency(amount)}{first.invoiceNumber ? `　單據 ${first.invoiceNumber}` : ""}</small>
        <small>{lines.slice(0, 4).map((l) => l.itemName).join("、")}{lines.length > 4 ? `…等 ${lines.length} 項` : ""}</small>
      </div>
      <div className="warning-box"><span>• <b>庫存數量不會退回。</b>這張單入庫時，庫存和異動紀錄已經加上去了，刪除只會讓它不再出現在報表。如果這張單其實是錯的，請另外到「庫存管理」把數量調整回正確的。</span></div>
      <label className="check-label"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />我知道庫存數量不會跟著退回</label>
      {error && <div className="error-box">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>取消</button><button className="primary-button danger-button" onClick={confirmDelete} disabled={submitting || !understood}>{submitting ? "刪除中…" : "確定刪除"}</button></div>
    </div>
  </div></div>;
}
