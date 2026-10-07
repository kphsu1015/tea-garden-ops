import { describe, expect, it } from "vitest";
import { expiryLabel, getExpiringBatches, roundQuantity, sortBatches } from "./inventory";
import type { InventoryBatch, InventoryItem } from "./types";

describe("roundQuantity", () => {
  it("庫存數量四捨五入到最接近的0.5", () => {
    expect(roundQuantity(0.5)).toBe(0.5);
    expect(roundQuantity(1.2)).toBe(1);
    expect(roundQuantity(1.3)).toBe(1.5);
    expect(roundQuantity(2)).toBe(2);
    expect(roundQuantity(0.2)).toBe(0);
    expect(roundQuantity(-1.5)).toBe(-1.5);
  });
});

function batch(id: string, expiryDate: string | null, quantity: number, createdAt = "2026-09-01T00:00:00Z"): InventoryBatch {
  return { id, expiryDate, quantity, createdAt };
}

function item(id: string, batches: InventoryBatch[]): InventoryItem {
  return {
    id, name: id, category: "早餐食材", unit: "瓶", safetyStock: 0, suggestedPurchase: 1, active: true, usageForecastEnabled: false,
    quantity: batches.reduce((sum, b) => sum + b.quantity, 0), batches,
  };
}

describe("sortBatches", () => {
  it("依到期日由早到晚，未標日期排最後，同日期依建立時間", () => {
    const sorted = sortBatches([
      batch("none", null, 1),
      batch("late", "2026-10-12", 1),
      batch("early-2", "2026-10-05", 1, "2026-09-03T00:00:00Z"),
      batch("early-1", "2026-10-05", 1, "2026-09-02T00:00:00Z"),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["early-1", "early-2", "late", "none"]);
  });
});

describe("getExpiringBatches", () => {
  const items = [
    item("牛奶", [batch("m1", "2026-10-05", 3), batch("m2", "2026-10-12", 6), batch("m3", "2026-11-30", 2)]),
    item("雞蛋", [batch("e1", "2026-09-30", 4), batch("e2", null, 10)]),
  ];

  it("同一品項的多個日期分開列出，只列14天內到期與已過期的批次，依日期排序", () => {
    const result = getExpiringBatches(items, "2026-10-02");
    expect(result.map((r) => [r.batch.id, r.daysLeft])).toEqual([["e1", -2], ["m1", 3], ["m2", 10]]);
  });

  it("數量為0或未標日期的批次不列入", () => {
    const result = getExpiringBatches([item("x", [batch("x1", "2026-10-03", 0), batch("x2", null, 5)])], "2026-10-02");
    expect(result).toEqual([]);
  });
});

describe("expiryLabel", () => {
  it("顯示剩餘天數或已過期天數", () => {
    expect(expiryLabel(-2)).toBe("已過期2天");
    expect(expiryLabel(0)).toBe("今天到期");
    expect(expiryLabel(3)).toBe("3天後到期");
  });
});
