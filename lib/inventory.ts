import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryItem, UsagePeriod } from "@/lib/types";

type InventoryItemRow = {
  id: string;
  name: string;
  category: string;
  storage_location: string;
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
};

export const INVENTORY_SELECT_COLUMNS = "id,name,category,storage_location,base_unit,quantity,safety_stock,suggested_purchase,supplier,nearest_expiry_date,active,usage_forecast_enabled,estimated_usage,usage_period";

export function mapInventoryRow(row: InventoryItemRow): InventoryItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    location: row.storage_location,
    unit: row.base_unit,
    quantity: Number(row.quantity),
    safetyStock: Number(row.safety_stock),
    suggestedPurchase: Number(row.suggested_purchase),
    supplier: row.supplier ?? undefined,
    expiryDate: row.nearest_expiry_date ?? undefined,
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
  if (input.usagePeriod !== "daily" && input.usagePeriod !== "weekly" && input.usagePeriod !== "monthly") {
    return { error: "請選擇使用週期（每日／每週／每月）。" };
  }
  return { columns: { usage_forecast_enabled: true, estimated_usage: input.estimatedUsage, usage_period: input.usagePeriod } };
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
