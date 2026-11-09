import { describe, expect, it } from "vitest";
import type { StockMovementRecord } from "./movements";
import { addDaysToKey, balancesAfter, dayLabel, detectPreset, formatMovementTime, groupByDay, isCursorTimestamp, isDateKey, movementsToCsv, presetRange, taipeiDateKeyOf } from "./movement-log";

const rec = (id: string, createdAt: string, change: number, extra: Partial<StockMovementRecord> = {}): StockMovementRecord => ({
  id, itemName: "豆漿", movementType: "日常領用", quantityChange: change, unit: "瓶", expiryDate: null, note: null, operatorName: "王管家", createdAt, ...extra,
});

describe("台北時間日期", () => {
  it("UTC 16:30 已經是台北隔天", () => {
    expect(taipeiDateKeyOf("2026-11-08T16:30:00.000Z")).toBe("2026-11-09");
    expect(formatMovementTime("2026-11-08T16:30:00.000Z")).toBe("00:30");
  });
  it("跨月加減天數", () => {
    expect(addDaysToKey("2026-11-01", -1)).toBe("2026-10-31");
    expect(addDaysToKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("dayLabel", () => {
  it("今天、昨天、同年、跨年", () => {
    expect(dayLabel("2026-11-09", "2026-11-09")).toContain("今天");
    expect(dayLabel("2026-11-08", "2026-11-09")).toContain("昨天");
    expect(dayLabel("2026-11-02", "2026-11-09")).toBe("11/02（一）");
    expect(dayLabel("2025-12-31", "2026-11-09")).toBe("2025/12/31（三）");
  });
});

describe("groupByDay", () => {
  it("依台北日期分組，維持由新到舊", () => {
    const rows = [rec("a", "2026-11-09T05:00:00Z", -1), rec("b", "2026-11-09T01:00:00Z", -1), rec("c", "2026-11-08T05:00:00Z", 2)];
    const groups = groupByDay(rows);
    expect(groups.map((g) => [g.key, g.rows.length])).toEqual([["2026-11-09", 2], ["2026-11-08", 1]]);
  });
});

describe("日期範圍快選", () => {
  it("今天、7 天、30 天、全部", () => {
    expect(presetRange("today", "2026-11-09")).toEqual({ from: "2026-11-09", to: "2026-11-09" });
    expect(presetRange("7d", "2026-11-09")).toEqual({ from: "2026-11-03", to: "2026-11-09" });
    expect(presetRange("30d", "2026-11-09")).toEqual({ from: "2026-10-11", to: "2026-11-09" });
    expect(presetRange("all", "2026-11-09")).toEqual({ from: "", to: "" });
  });
  it("手動選的範圍對得上快選就亮起來，對不上回傳 null", () => {
    expect(detectPreset("2026-11-03", "2026-11-09", "2026-11-09")).toBe("7d");
    expect(detectPreset("2026-11-01", "2026-11-09", "2026-11-09")).toBeNull();
  });
  it("日期格式檢查", () => {
    expect(isDateKey("2026-11-09")).toBe(true);
    expect(isDateKey("2026-13-40")).toBe(false);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2028-02-29")).toBe(true);
    expect(isDateKey("11/09")).toBe(false);
    expect(isDateKey(null)).toBe(false);
  });
});

describe("isCursorTimestamp（翻頁游標格式）", () => {
  it("接受資料庫實際回傳的格式", () => {
    expect(isCursorTimestamp("2026-11-09T00:53:21.975092+00:00")).toBe(true);
    expect(isCursorTimestamp("2026-11-09T00:53:21Z")).toBe(true);
    expect(isCursorTimestamp("2026-11-09T08:53:21.5+08")).toBe(true);
  });
  it("擋掉會破壞篩選語法的內容", () => {
    expect(isCursorTimestamp("2026-11-09T00:53:21Z),id.gt.0")).toBe(false);
    expect(isCursorTimestamp("2026-11-09")).toBe(false);
    expect(isCursorTimestamp("")).toBe(false);
  });
});

describe("balancesAfter（用目前庫存往回推）", () => {
  it("最新一筆之後就是目前庫存，往前一筆一筆扣回去", () => {
    // 目前 5：最新領用 -2（之後剩 5，之前 7）、再前面入庫 +10（之後剩 7，之前 -3 不合理但只驗算式）
    const map = balancesAfter([rec("new", "2026-11-09T05:00:00Z", -2), rec("old", "2026-11-08T05:00:00Z", 10)], 5);
    expect(map.get("new")).toBe(5);
    expect(map.get("old")).toBe(7);
  });
  it("0.5 的小數不會出現浮點誤差", () => {
    const map = balancesAfter([rec("a", "2026-11-09T05:00:00Z", 0.5), rec("b", "2026-11-08T05:00:00Z", 0.1), rec("c", "2026-11-07T05:00:00Z", 0.2)], 3);
    expect(map.get("c")).toBe(2.4);
  });
});

describe("balancesAfter 同一次操作的多筆", () => {
  it("同一時間的一組只在最上面一筆顯示操作後庫存，其餘是 null，再往前的不受影響", () => {
    const same = "2026-11-09T05:00:00Z";
    const map = balancesAfter([rec("a", same, -1), rec("b", same, -2), rec("c", "2026-11-08T05:00:00Z", 10)], 7);
    expect(map.get("a")).toBe(7);
    expect(map.get("b")).toBeNull();
    // 這組操作前是 7 + 3 = 10，所以更早那筆（+10）之後剩 10
    expect(map.get("c")).toBe(10);
  });
});

describe("movementsToCsv", () => {
  it("有 BOM、標題與逗號／引號跳脫", () => {
    const csv = movementsToCsv([rec("a", "2026-11-09T05:00:00Z", -2, { note: '備註,含"引號"' })]);
    expect(csv.startsWith("﻿日期,時間,品項")).toBe(true);
    expect(csv).toContain('"備註,含""引號"""');
    expect(csv).toContain("2026-11-09,13:00,豆漿,日常領用,-2,瓶");
  });
  it("以 = 開頭的備註不會被 Excel 當成公式", () => {
    const csv = movementsToCsv([rec("a", "2026-11-09T05:00:00Z", 1, { note: "=HYPERLINK(1)" })]);
    expect(csv).toContain("'=HYPERLINK(1)");
  });
});
