// 進貨單的「常用供應商」：從最近的進貨單與庫存品項設定的供應商整理出來，填單時一鍵帶入，
// 不用每次重打，也避免同一家店打出好幾種寫法（「開元」「開元超市」）讓報表分成好幾條。

const clean = (value: string | null | undefined) => (value ?? "").trim();
const key = (value: string) => value.replace(/\s+/g, "").toLowerCase();

export interface SupplierLists {
  // 最常用的幾家（依出現次數，進貨單比庫存品項的設定算得重）
  frequent: string[];
  // 全部不重複的供應商（給輸入框的下拉建議用）
  all: string[];
}

export function collectSuppliers(
  receipts: Array<{ supplier?: string | null }>,
  inventory: Array<{ supplier?: string | null }>,
  limit = 6,
): SupplierLists {
  const counts = new Map<string, { name: string; score: number }>();
  const add = (raw: string | null | undefined, weight: number) => {
    const name = clean(raw);
    if (!name) return;
    const k = key(name);
    const hit = counts.get(k);
    if (hit) hit.score += weight; else counts.set(k, { name, score: weight });
  };
  // 進貨單代表「真的進過貨」，算 3 分；庫存品項上設定的供應商算 1 分。
  receipts.forEach((r) => add(r.supplier, 3));
  inventory.forEach((i) => add(i.supplier, 1));
  const sorted = [...counts.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-Hant"));
  return { frequent: sorted.slice(0, limit).map((s) => s.name), all: sorted.map((s) => s.name) };
}
