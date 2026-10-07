import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryBatch, InventoryItem, MovementType, UsagePeriod } from "@/lib/types";

// 新增庫存異動：中文顯示用的異動類型對應到Postgres的movement_type enum（schema.sql）。
export const MOVEMENT_TYPE_ENUM: Record<MovementType, string> = {
  "採購入庫": "purchase_in",
  "日常領用": "daily_use",
  "客房補充": "room_supply",
  "食材使用": "food_use",
  "損壞": "damaged",
  "過期報廢": "expired",
  "盤點調整": "adjustment",
};

// 給異動歷史查詢頁用：從Postgres enum值反查中文顯示名稱。
export const MOVEMENT_TYPE_LABELS: Record<string, MovementType> = Object.fromEntries(
  Object.entries(MOVEMENT_TYPE_ENUM).map(([label, value]) => [value, label as MovementType]),
);

// 大部分異動類型的增減方向是固定的（採購入庫一定是增加，領用／損壞／報廢一定是減少），
// 只有「盤點調整」允許使用者自己選方向。null代表要讓使用者自己選。
export const MOVEMENT_TYPE_DEFAULT_DIRECTION: Record<MovementType, "increase" | "decrease" | null> = {
  "採購入庫": "increase",
  "日常領用": "decrease",
  "客房補充": "decrease",
  "食材使用": "decrease",
  "損壞": "decrease",
  "過期報廢": "decrease",
  "盤點調整": null,
};

type InventoryItemRow = {
  id: string;
  name: string;
  category: string;
  base_unit: string;
  quantity: number;
  safety_stock: number;
  suggested_purchase: number;
  supplier: string | null;
  nearest_expiry_date: string | null;
  active: boolean;
  usage_forecast_enabled: boolean;
  estimated_usage: number | null;
  usage_period: string | null;
  inventory_batches?: Array<{ id: string; expiry_date: string | null; quantity: number; created_at: string }> | null;
};

export const INVENTORY_SELECT_COLUMNS = "id,name,category,base_unit,quantity,safety_stock,suggested_purchase,supplier,nearest_expiry_date,active,usage_forecast_enabled,estimated_usage,usage_period,inventory_batches(id,expiry_date,quantity,created_at)";

// 有日期的依到期日由早到晚，未標日期的排最後；跟資料庫先到期先出的扣庫存順序一致。
export function sortBatches(batches: InventoryBatch[]): InventoryBatch[] {
  return [...batches].sort((a, b) => {
    if (a.expiryDate !== b.expiryDate) {
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate < b.expiryDate ? -1 : 1;
    }
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export function mapInventoryRow(row: InventoryItemRow): InventoryItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.base_unit,
    quantity: Number(row.quantity),
    safetyStock: Number(row.safety_stock),
    suggestedPurchase: Number(row.suggested_purchase),
    supplier: row.supplier ?? undefined,
    expiryDate: row.nearest_expiry_date ?? undefined,
    batches: sortBatches((row.inventory_batches ?? [])
      .filter((batch) => Number(batch.quantity) > 0)
      .map((batch) => ({ id: batch.id, expiryDate: batch.expiry_date, quantity: Number(batch.quantity), createdAt: batch.created_at }))),
    active: row.active,
    usageForecastEnabled: row.usage_forecast_enabled,
    estimatedUsage: row.estimated_usage !== null ? Number(row.estimated_usage) : undefined,
    usagePeriod: (row.usage_period as UsagePeriod | null) ?? undefined,
  };
}

export async function listInventoryItems(supabase: SupabaseClient): Promise<InventoryItem[]> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select(INVENTORY_SELECT_COLUMNS)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as InventoryItemRow[]).map(mapInventoryRow);
}

// 依表單輸入組出要寫入的欄位；usageForecastEnabled未提供時視為「這次更新不動預估使用量」。
export function buildUsageForecastColumns(input: { usageForecastEnabled?: boolean; estimatedUsage?: number; usagePeriod?: string }): { columns: Record<string, unknown> } | { error: string } {
  if (typeof input.usageForecastEnabled !== "boolean") return { columns: {} };
  if (!input.usageForecastEnabled) {
    return { columns: { usage_forecast_enabled: false, estimated_usage: null, usage_period: null } };
  }
  if (typeof input.estimatedUsage !== "number" || !Number.isFinite(input.estimatedUsage) || input.estimatedUsage <= 0) {
    return { error: "啟用預估使用量時，預估使用量必須大於0。" };
  }
  // 預估使用量比照庫存數量一律整數，即使呼叫端傳了小數也在這裡四捨五入；四捨五入後若變成0視同未填寫。
  const roundedUsage = Math.round(input.estimatedUsage);
  if (roundedUsage <= 0) {
    return { error: "啟用預估使用量時，預估使用量必須大於0。" };
  }
  if (input.usagePeriod !== "daily" && input.usagePeriod !== "weekly" && input.usagePeriod !== "monthly") {
    return { error: "請選擇使用週期（每日／每週／每月）。" };
  }
  return { columns: { usage_forecast_enabled: true, estimated_usage: roundedUsage, usage_period: input.usagePeriod } };
}

// --- 預估使用量／低庫存判斷（純函式，前後端共用） ---

const PERIOD_UNIT_LABEL: Record<UsagePeriod, string> = { daily: "天", weekly: "週", monthly: "個月" };
const PERIOD_FREQUENCY_LABEL: Record<UsagePeriod, string> = { daily: "每日", weekly: "每週", monthly: "每月" };

export function periodFrequencyLabel(period: UsagePeriod): string {
  return PERIOD_FREQUENCY_LABEL[period];
}

export function isForecastActive(item: Pick<InventoryItem, "usageForecastEnabled" | "estimatedUsage" | "usagePeriod">): boolean {
  return item.usageForecastEnabled && typeof item.estimatedUsage === "number" && item.estimatedUsage > 0 && !!item.usagePeriod;
}

export type LowStockReason = "safety" | "forecast" | "both" | null;

export function getLowStockReason(item: Pick<InventoryItem, "quantity" | "safetyStock" | "usageForecastEnabled" | "estimatedUsage" | "usagePeriod">): LowStockReason {
  const belowSafety = item.quantity <= item.safetyStock;
  if (!isForecastActive(item)) return belowSafety ? "safety" : null;
  const belowForecast = item.quantity < (item.estimatedUsage as number);
  if (belowSafety && belowForecast) return "both";
  if (belowSafety) return "safety";
  if (belowForecast) return "forecast";
  return null;
}

export function lowStockReasonLabel(reason: LowStockReason): string {
  if (reason === "safety") return "低於安全庫存";
  if (reason === "forecast") return "預估用量不足";
  if (reason === "both") return "低於安全庫存及預估用量";
  return "";
}

// 目前庫存 ÷ 每個週期預估使用量 = 還可以撐幾個週期，用週期本身的單位顯示（天／週／個月），只是預估，不會扣除庫存。
// 顯示一律四捨五入到整數（不足1個週期至少顯示1，避免顯示「0天」造成誤解已經沒有庫存）。
export function estimatedRemainingLabel(item: Pick<InventoryItem, "quantity" | "usageForecastEnabled" | "estimatedUsage" | "usagePeriod">): string | null {
  if (!isForecastActive(item)) return null;
  const usage = item.estimatedUsage as number;
  const period = item.usagePeriod as UsagePeriod;
  const periodsRemaining = item.quantity / usage;
  const rounded = item.quantity > 0 ? Math.max(1, Math.round(periodsRemaining)) : 0;
  return `預估可使用${rounded}${PERIOD_UNIT_LABEL[period]}`;
}

// 庫存數量（異動、盤點、採購、進貨單）最小單位為0.5，例如0.5包、1.5公斤；傳入其他小數會四捨五入到最接近的0.5。
export const QUANTITY_STEP = 0.5;
export function roundQuantity(value: number): number {
  return Math.round(value / QUANTITY_STEP) * QUANTITY_STEP;
}

// --- 即將過期批次（純函式，前後端共用） ---

export const EXPIRY_WARNING_DAYS = 14;

export interface ExpiringBatch {
  item: InventoryItem;
  batch: InventoryBatch;
  expiryDate: string;
  daysLeft: number;
}

export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function dateKeyToDayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

// 今天（Asia/Taipei）的YYYY-MM-DD，跟資料庫date欄位直接比較，不受員工裝置時區影響。
export function taipeiDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// 列出已過期或withinDays天內到期的批次（未標日期的批次不列入），依到期日由早到晚排序。
export function getExpiringBatches(items: InventoryItem[], todayKey: string, withinDays = EXPIRY_WARNING_DAYS): ExpiringBatch[] {
  const today = dateKeyToDayNumber(todayKey);
  return items
    .flatMap((item) => item.batches
      .filter((batch) => batch.expiryDate !== null && batch.quantity > 0)
      .map((batch) => ({ item, batch, expiryDate: batch.expiryDate as string, daysLeft: dateKeyToDayNumber(batch.expiryDate as string) - today })))
    .filter((entry) => entry.daysLeft <= withinDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export function expiryLabel(daysLeft: number): string {
  if (daysLeft < 0) return `已過期${-daysLeft}天`;
  if (daysLeft === 0) return "今天到期";
  return `${daysLeft}天後到期`;
}

// --- 進貨單品項比對（純函式）：AI辨識的品名如果沒有「精確」對應現有庫存，就不可以自動建立，
// 改由管理員從最多5個相似品項中選擇、建立新品項，或忽略此品項。 ---

function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

export function findExactInventoryMatch(inventory: InventoryItem[], itemName: string): InventoryItem | undefined {
  const normalized = normalizeItemName(itemName);
  if (!normalized) return undefined;
  return inventory.find((item) => normalizeItemName(item.name) === normalized);
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const editSimilarity = 1 - levenshteinDistance(a, b) / maxLen;
  const containment = a.includes(b) || b.includes(a) ? Math.min(a.length, b.length) / maxLen : 0;
  return Math.max(editSimilarity, containment);
}

const SIMILARITY_THRESHOLD = 0.34;

// 最多回傳5個依相似度排序的候選品項，避免名稱略有不同（例如「衛生紙」vs「抽取式衛生紙」）就重複建立。
export function findSimilarInventoryItems(inventory: InventoryItem[], itemName: string, limit = 5): InventoryItem[] {
  const normalized = normalizeItemName(itemName);
  if (!normalized) return [];
  return inventory
    .map((item) => ({ item, score: nameSimilarity(normalizeItemName(item.name), normalized) }))
    .filter(({ score }) => score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
