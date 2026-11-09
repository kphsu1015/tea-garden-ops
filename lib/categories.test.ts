import { describe, expect, it } from "vitest";
import { findOrphanCategories } from "./categories";

describe("findOrphanCategories", () => {
  it("品項或進貨明細用到、但分類清單裡沒有的名稱，算孤兒", () => {
    const orphans = findOrphanCategories(["早餐食材"], new Map([["早餐食材", 3], ["舊名稱", 2]]), new Map([["舊名稱", 5], ["另一個", 1]]));
    expect(orphans).toEqual([
      { name: "另一個", itemCount: 0, receiptLineCount: 1 },
      { name: "舊名稱", itemCount: 2, receiptLineCount: 5 },
    ]);
  });
  it("「待分類」是 AI 判斷不出來的標記，不算孤兒", () => {
    expect(findOrphanCategories([], new Map([["待分類", 4]]), new Map())).toEqual([]);
  });
  it("全部都在清單裡就沒有孤兒", () => {
    expect(findOrphanCategories(["A", "B"], new Map([["A", 1]]), new Map([["B", 2]]))).toEqual([]);
  });
});
