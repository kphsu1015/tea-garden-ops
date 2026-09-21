// 進貨金額報表：共用型別、Asia/Taipei月份工具與Supabase RPC回傳值的camelCase轉換。
// 所有金額加總都在Supabase RPC（Postgres numeric）裡完成，這裡只負責顯示格式，不做加總，避免JS浮點數誤差。

export function getTaipeiMonthStart(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}-01`;
}

export function isValidMonthStart(value: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(value);
}

export function shiftMonth(monthStart: string, delta: number): string {
  const [y, m] = monthStart.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

export function monthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  return `${y}年${m}月`;
}

export function shortMonthLabel(monthStart: string): string {
  const [, m] = monthStart.split("-").map(Number);
  return `${m}月`;
}

export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  return `NT$ ${Math.round(amount).toLocaleString("zh-TW")}`;
}

export interface PurchaseMonthlySummary {
  totalAmount: number;
  receiptCount: number;
  itemCount: number;
  topCategoryName: string | null;
  topCategoryAmount: number | null;
  topSupplierName: string | null;
  topSupplierAmount: number | null;
  prevMonthTotalAmount: number;
  // 運費另外列出；其他費用＝處理費／包裝費＋稅額＋其他費用（折扣已從中扣除），不含運費，避免跟totalAmount重複認知。
  shippingAmount: number;
  otherFeeAmount: number;
}

export interface PurchaseTrendPoint { month: string; totalAmount: number }
export interface PurchaseCategoryBreakdown { category: string; totalAmount: number; incompleteLineCount: number }
export interface PurchaseTopItem { itemName: string; totalAmount: number; totalQuantity: number; unit: string }
export interface PurchaseSupplierBreakdown { supplier: string; totalAmount: number; receiptCount: number }

export interface PurchaseReportLine {
  receiptId: string;
  purchaseDate: string | null;
  supplier: string | null;
  invoiceNumber: string | null;
  status: string;
  receiptTotalAmount: number | null;
  lineId: string;
  itemName: string;
  category: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  totalPrice: number | null;
  effectiveAmount: number | null;
}

type RawSummaryRow = {
  total_amount: number; receipt_count: number; item_count: number;
  top_category_name: string | null; top_category_amount: number | null;
  top_supplier_name: string | null; top_supplier_amount: number | null;
  prev_month_total_amount: number;
  shipping_amount: number; other_fee_amount: number;
};

export function mapSummaryRow(input: unknown): PurchaseMonthlySummary {
  const row = input as RawSummaryRow;
  return {
    totalAmount: Number(row.total_amount) || 0,
    receiptCount: Number(row.receipt_count) || 0,
    itemCount: Number(row.item_count) || 0,
    topCategoryName: row.top_category_name,
    topCategoryAmount: row.top_category_amount !== null ? Number(row.top_category_amount) : null,
    topSupplierName: row.top_supplier_name,
    topSupplierAmount: row.top_supplier_amount !== null ? Number(row.top_supplier_amount) : null,
    prevMonthTotalAmount: Number(row.prev_month_total_amount) || 0,
    shippingAmount: Number(row.shipping_amount) || 0,
    otherFeeAmount: Number(row.other_fee_amount) || 0,
  };
}

export function mapTrendRow(row: { month: string; total_amount: number }): PurchaseTrendPoint {
  return { month: row.month, totalAmount: Number(row.total_amount) || 0 };
}

export function mapCategoryRow(row: { category: string; total_amount: number; incomplete_line_count: number }): PurchaseCategoryBreakdown {
  return { category: row.category, totalAmount: Number(row.total_amount) || 0, incompleteLineCount: Number(row.incomplete_line_count) || 0 };
}

export function mapTopItemRow(row: { item_name: string; total_amount: number; total_quantity: number; unit: string }): PurchaseTopItem {
  return { itemName: row.item_name, totalAmount: Number(row.total_amount) || 0, totalQuantity: Number(row.total_quantity) || 0, unit: row.unit };
}

export function mapSupplierRow(row: { supplier: string; total_amount: number; receipt_count: number }): PurchaseSupplierBreakdown {
  return { supplier: row.supplier, totalAmount: Number(row.total_amount) || 0, receiptCount: Number(row.receipt_count) || 0 };
}

type RawLineRow = {
  receipt_id: string; purchase_date: string | null; supplier: string | null; invoice_number: string | null; status: string;
  receipt_total_amount: number | null;
  line_id: string; item_name: string; category: string; quantity: number; unit: string;
  unit_price: number | null; total_price: number | null; effective_amount: number | null;
};

export function mapLineRow(row: RawLineRow): PurchaseReportLine {
  return {
    receiptId: row.receipt_id,
    purchaseDate: row.purchase_date,
    supplier: row.supplier,
    invoiceNumber: row.invoice_number,
    status: row.status,
    receiptTotalAmount: row.receipt_total_amount !== null ? Number(row.receipt_total_amount) : null,
    lineId: row.line_id,
    itemName: row.item_name,
    category: row.category,
    quantity: Number(row.quantity) || 0,
    unit: row.unit,
    unitPrice: row.unit_price !== null ? Number(row.unit_price) : null,
    totalPrice: row.total_price !== null ? Number(row.total_price) : null,
    effectiveAmount: row.effective_amount !== null ? Number(row.effective_amount) : null,
  };
}
