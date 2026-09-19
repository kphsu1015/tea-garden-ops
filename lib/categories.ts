import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryCategory } from "@/lib/types";
import { defaultCategorySeed } from "@/lib/categories-shared";

export { PENDING_CATEGORY, defaultCategorySeed } from "@/lib/categories-shared";

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
  const [categoryResult, itemResult, lineResult] = await Promise.all([
    supabase.from("inventory_categories").select("id,name,sort_order,active,created_at").order("sort_order", { ascending: true }),
    supabase.from("inventory_items").select("category"),
    supabase.from("receipt_lines").select("category"),
  ]);
  if (categoryResult.error) throw new Error(categoryResult.error.message);
  if (itemResult.error) throw new Error(itemResult.error.message);
  if (lineResult.error) throw new Error(lineResult.error.message);

  const itemCounts = new Map<string, number>();
  for (const row of (itemResult.data ?? []) as Array<{ category: string | null }>) {
    if (!row.category) continue;
    itemCounts.set(row.category, (itemCounts.get(row.category) ?? 0) + 1);
  }
  const lineCounts = new Map<string, number>();
  for (const row of (lineResult.data ?? []) as Array<{ category: string | null }>) {
    if (!row.category) continue;
    lineCounts.set(row.category, (lineCounts.get(row.category) ?? 0) + 1);
  }

  type CategoryRow = { id: string; name: string; sort_order: number; active: boolean; created_at: string };
  return ((categoryResult.data ?? []) as CategoryRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    active: row.active,
    itemCount: itemCounts.get(row.name) ?? 0,
    receiptLineCount: lineCounts.get(row.name) ?? 0,
    createdAt: row.created_at,
  }));
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
