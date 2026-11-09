import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryCategory } from "@/lib/types";
import { PENDING_CATEGORY } from "@/lib/categories-shared";
import { defaultCategorySeed } from "@/lib/categories-shared";

export { PENDING_CATEGORY, defaultCategorySeed } from "@/lib/categories-shared";

export interface OrphanCategory { name: string; itemCount: number; receiptLineCount: number }

// Supabase尚未設定（zero-config demo）時顯示的唯讀示範分類，不代表任何真實資料。
export function demoCategoryList(): InventoryCategory[] {
  return defaultCategorySeed.map((name, index) => ({
    id: `demo-${index}`,
    name,
    sortOrder: index + 1,
    active: true,
    itemCount: 0,
    receiptLineCount: 0,
    createdAt: new Date(0).toISOString(),
  }));
}

// supabase為呼叫者已登入使用者的session client，所有查詢都受RLS約束（不繞過權限）。
export async function listCategories(supabase: SupabaseClient): Promise<InventoryCategory[]> {
  return (await listCategoriesWithOrphans(supabase)).categories;
}

// 分類清單，加上「孤兒分類」：品項或進貨明細用到、但不在分類清單裡的名稱（例如早期改名沒有連動留下的舊名稱）。
// 「待分類」是AI判斷不出來時的標記，本來就不寫進分類表，不算孤兒。
export async function listCategoriesWithOrphans(supabase: SupabaseClient): Promise<{ categories: InventoryCategory[]; orphans: OrphanCategory[] }> {
  const [categoryResult, itemResult, lineResult] = await Promise.all([
    supabase.from("inventory_categories").select("id,name,sort_order,active,created_at").order("sort_order", { ascending: true }),
    readAllCategoryColumn(supabase, "inventory_items"),
    readAllCategoryColumn(supabase, "receipt_lines"),
  ]);
  if (categoryResult.error) throw new Error(categoryResult.error.message);

  const itemCounts = new Map<string, number>();
  for (const row of itemResult.data) {
    if (!row.category) continue;
    itemCounts.set(row.category, (itemCounts.get(row.category) ?? 0) + 1);
  }
  const lineCounts = new Map<string, number>();
  for (const row of lineResult.data) {
    if (!row.category) continue;
    lineCounts.set(row.category, (lineCounts.get(row.category) ?? 0) + 1);
  }

  type CategoryRow = { id: string; name: string; sort_order: number; active: boolean; created_at: string };
  const rows = (categoryResult.data ?? []) as CategoryRow[];
  const orphans = findOrphanCategories(rows.map((row) => row.name), itemCounts, lineCounts);
  const categories = rows.map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    active: row.active,
    itemCount: itemCounts.get(row.name) ?? 0,
    receiptLineCount: lineCounts.get(row.name) ?? 0,
    createdAt: row.created_at,
  }));
  return { categories, orphans };
}

export async function listActiveCategoryNames(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from("inventory_categories")
    .select("name")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => (row as { name: string }).name);
}

// 用到、但不在分類清單裡的名稱（「待分類」不算）。純函式，方便測試。
export function findOrphanCategories(knownNames: string[], itemCounts: Map<string, number>, lineCounts: Map<string, number>): OrphanCategory[] {
  const known = new Set(knownNames);
  const names = new Set<string>([...itemCounts.keys(), ...lineCounts.keys()].filter((name) => !known.has(name) && name !== PENDING_CATEGORY));
  return [...names].sort((x, y) => x.localeCompare(y, "zh-Hant")).map((name) => ({ name, itemCount: itemCounts.get(name) ?? 0, receiptLineCount: lineCounts.get(name) ?? 0 }));
}

// Supabase 一次最多回 1000 筆；進貨明細會越來越多，要分頁讀完，不然計數與孤兒偵測會被截斷。
const PAGE = 1000;
async function readAllCategoryColumn(supabase: SupabaseClient, table: "inventory_items" | "receipt_lines"): Promise<{ data: Array<{ category: string | null }> }> {
  const rows: Array<{ category: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select("category").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<{ category: string | null }>));
    if (!data || data.length < PAGE) break;
  }
  return { data: rows };
}
