import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandoverNote, PurchaseRequest, PurchaseStatus, ReceiptCharge, ReceiptChargeType, ReceiptRecord } from "@/lib/types";

// ===== 共用工具 =====

// 跟demo資料一致的「YYYY-MM-DD HH:mm」，一律用Asia/Taipei，不受伺服器或員工手機時區影響。
export function formatTaipeiDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// PostgREST的embedded resource有時回傳物件、有時回傳陣列，統一攤平。
function firstOf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

// ===== 採購需求 =====

// 資料庫enum（pending/approved/ordered/arrived/stocked/paused）與畫面中文狀態對照。
// approved目前畫面沒有對應欄位，歸入「待確認」顯示。
const PURCHASE_STATUS_FROM_DB: Record<string, PurchaseStatus> = {
  pending: "待確認", approved: "待確認", ordered: "已訂購", arrived: "已到貨", stocked: "已入庫", paused: "暫緩",
};
const PURCHASE_STATUS_TO_DB: Record<PurchaseStatus, string> = {
  "待確認": "pending", "已訂購": "ordered", "已到貨": "arrived", "已入庫": "stocked", "暫緩": "paused",
};

export function isPurchaseStatus(value: unknown): value is PurchaseStatus {
  return typeof value === "string" && value in PURCHASE_STATUS_TO_DB;
}
export function purchaseStatusToDb(status: PurchaseStatus): string {
  return PURCHASE_STATUS_TO_DB[status];
}

export const PURCHASE_SELECT_COLUMNS =
  "id,inventory_item_id,item_name,quantity,unit,priority,status,note,created_at,staff_profiles!purchase_requests_requester_id_fkey(display_name)";

type RawPurchaseRow = {
  id: string;
  inventory_item_id: string | null;
  item_name: string;
  quantity: number;
  unit: string;
  priority: string;
  status: string;
  note: string | null;
  created_at: string;
  staff_profiles: { display_name: string } | { display_name: string }[] | null;
};

export function mapPurchaseRow(row: RawPurchaseRow): PurchaseRequest {
  return {
    id: row.id,
    itemName: row.item_name,
    inventoryItemId: row.inventory_item_id ?? undefined,
    quantity: Number(row.quantity),
    unit: row.unit,
    priority: row.priority === "urgent" ? "急件" : "一般",
    status: PURCHASE_STATUS_FROM_DB[row.status] ?? "待確認",
    requester: firstOf(row.staff_profiles)?.display_name ?? "—",
    requestedAt: formatTaipeiDateTime(row.created_at),
    note: row.note ?? undefined,
  };
}

// ===== 交接留言 =====

export const NOTE_CATEGORIES: HandoverNote["category"][] = ["客人需求", "房務問題", "設備維修", "餐飲", "重要公告"];

export const NOTE_SELECT_COLUMNS =
  "id,category,content,important,created_at,staff_profiles!handover_notes_author_id_fkey(display_name)";

type RawNoteRow = {
  id: string;
  category: string;
  content: string;
  important: boolean;
  created_at: string;
  staff_profiles: { display_name: string } | { display_name: string }[] | null;
};

export function mapNoteRow(row: RawNoteRow): HandoverNote {
  return {
    id: row.id,
    category: (NOTE_CATEGORIES as string[]).includes(row.category) ? row.category as HandoverNote["category"] : "重要公告",
    content: row.content,
    author: firstOf(row.staff_profiles)?.display_name ?? "—",
    createdAt: formatTaipeiDateTime(row.created_at),
    important: row.important,
  };
}

// ===== 進貨單 =====

export const RECEIPT_SELECT_COLUMNS =
  "id,supplier,purchase_date,invoice_number,total_amount,original_file_name,storage_path,status,warnings,delete_after,created_at," +
  "receipt_lines(id,inventory_item_id,item_name,quantity,unit,unit_price,total_price,category,created_at)," +
  "receipt_charges(id,charge_type,description,amount,created_at)";

type RawReceiptRow = {
  id: string;
  supplier: string | null;
  purchase_date: string | null;
  invoice_number: string | null;
  total_amount: number | null;
  original_file_name: string;
  storage_path: string | null;
  status: string;
  warnings: unknown;
  delete_after: string;
  created_at: string;
  receipt_lines: Array<{
    id: string; inventory_item_id: string | null; item_name: string; quantity: number; unit: string;
    unit_price: number | null; total_price: number | null; category: string | null; created_at: string;
  }> | null;
  receipt_charges: Array<{ id: string; charge_type: string; description: string | null; amount: number; created_at: string }> | null;
};

const RECEIPT_STATUS_FROM_DB: Record<string, ReceiptRecord["status"]> = {
  pending: "待確認", stocked: "已入庫", failed: "辨識失敗",
};

export function mapReceiptRow(row: RawReceiptRow): ReceiptRecord {
  const byCreated = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
  return {
    id: row.id,
    supplier: row.supplier ?? "",
    purchaseDate: row.purchase_date ?? "",
    invoiceNumber: row.invoice_number ?? undefined,
    totalAmount: row.total_amount === null ? undefined : Number(row.total_amount),
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((w): w is string => typeof w === "string") : [],
    lines: [...(row.receipt_lines ?? [])].sort(byCreated).map((line) => ({
      id: line.id,
      itemName: line.item_name,
      quantity: Number(line.quantity),
      unit: line.unit,
      unitPrice: line.unit_price === null ? undefined : Number(line.unit_price),
      totalPrice: line.total_price === null ? undefined : Number(line.total_price),
      inventoryItemId: line.inventory_item_id ?? undefined,
      category: line.category ?? undefined,
    })),
    charges: [...(row.receipt_charges ?? [])].sort(byCreated).map((charge): ReceiptCharge => ({
      id: charge.id,
      chargeType: charge.charge_type as ReceiptChargeType,
      description: charge.description ?? undefined,
      amount: Number(charge.amount),
    })),
    fileName: row.original_file_name,
    storagePath: row.storage_path ?? undefined,
    status: RECEIPT_STATUS_FROM_DB[row.status] ?? "已入庫",
    createdAt: row.created_at,
    // 手動輸入的進貨單沒有照片，沒有「照片保存至」可言。
    deleteAfter: row.storage_path ? row.delete_after : undefined,
  };
}

// ===== 共用設定：進貨單照片保存天數 =====

export const RETENTION_DAY_OPTIONS = [30, 60, 90, 180, 365] as const;
export const DEFAULT_RETENTION_DAYS = 90;

export function isValidRetentionDays(value: unknown): value is number {
  return typeof value === "number" && (RETENTION_DAY_OPTIONS as readonly number[]).includes(value);
}

export async function getReceiptRetentionDays(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "receipt_retention_days").maybeSingle();
  const value = Number(data?.value);
  return isValidRetentionDays(value) ? value : DEFAULT_RETENTION_DAYS;
}
