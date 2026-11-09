import { describe, expect, it } from "vitest";
import { describeDuplicate, findDuplicateReceipt } from "./receipt-duplicates";
import { DRAFT_MAX_AGE_MS, clearDraft, draftAgeLabel, draftKey, loadDraft, saveDraft } from "./receipt-draft";
import type { ReceiptRecord } from "./types";

const receipt = (over: Partial<ReceiptRecord> = {}): ReceiptRecord => ({
  id: "r1", fileName: "手動輸入進貨單", status: "已入庫", createdAt: "2026-11-01T00:00:00Z", supplier: "開元", purchaseDate: "2026-11-01",
  invoiceNumber: "AB-123", totalAmount: 2160, warnings: [], lines: [{ id: "l1", itemName: "醬油", quantity: 1, unit: "瓶" }], charges: [], ...over,
});

describe("findDuplicateReceipt", () => {
  it("單據號碼一樣（忽略大小寫與空白）算重複", () => {
    const hit = findDuplicateReceipt([receipt()], { invoiceNumber: " ab-123 " });
    expect(hit?.reason).toBe("invoice");
  });
  it("沒有單據號碼時，同天同供應商同金額算重複", () => {
    expect(findDuplicateReceipt([receipt({ invoiceNumber: undefined })], { purchaseDate: "2026-11-01", supplier: "開元", totalAmount: 2160 })?.reason).toBe("same-day-total");
  });
  it("金額不同、日期不同、或沒填單據號碼與供應商，都不算重複", () => {
    const list = [receipt()];
    expect(findDuplicateReceipt(list, { purchaseDate: "2026-11-01", supplier: "開元", totalAmount: 100 })).toBeNull();
    expect(findDuplicateReceipt(list, { purchaseDate: "2026-11-02", supplier: "開元", totalAmount: 2160 })).toBeNull();
    expect(findDuplicateReceipt(list, { invoiceNumber: "", supplier: "", totalAmount: 2160 })).toBeNull();
  });
  it("說明文字帶出是哪一張", () => {
    expect(describeDuplicate({ receipt: receipt(), reason: "invoice" })).toContain("AB-123");
  });
});

function fakeStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}

describe("進貨單草稿", () => {
  it("存了又讀得回來", () => {
    const s = fakeStorage();
    expect(saveDraft("u1", { mode: "manual", hadPhoto: false, analysis: { supplier: "開元" } }, 1000, s)).toBe(true);
    const d = loadDraft<{ supplier: string }>("u1", 2000, s);
    expect(d?.analysis.supplier).toBe("開元");
    expect(d?.mode).toBe("manual");
  });
  it("超過 7 天的草稿作廢並清掉", () => {
    const s = fakeStorage();
    saveDraft("u1", { mode: "manual", hadPhoto: false, analysis: { a: 1 } }, 0, s);
    expect(loadDraft("u1", DRAFT_MAX_AGE_MS + 1, s)).toBeNull();
    expect(s.data.has(draftKey("u1"))).toBe(false);
  });
  it("壞掉的內容不會讓頁面出錯，而是當作沒有草稿", () => {
    const s = fakeStorage();
    s.setItem(draftKey("u1"), "{不是 json");
    expect(loadDraft("u1", 0, s)).toBeNull();
    expect(s.data.has(draftKey("u1"))).toBe(false);
  });
  it("清除", () => {
    const s = fakeStorage();
    saveDraft("u1", { mode: "scan", hadPhoto: true, analysis: {} }, 0, s);
    clearDraft("u1", s);
    expect(loadDraft("u1", 1, s)).toBeNull();
  });
  it("寫入失敗（空間滿）回傳 false，不丟錯", () => {
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} };
    expect(saveDraft("u1", { mode: "manual", hadPhoto: false, analysis: {} }, 0, full)).toBe(false);
  });
  it("不同帳號的草稿分開，A 看不到 B 的；沒有帳號識別就不存", () => {
    const s = fakeStorage();
    saveDraft("alice", { mode: "manual", hadPhoto: false, analysis: { supplier: "A的" } }, 0, s);
    expect(loadDraft("bob", 1, s)).toBeNull();
    expect(loadDraft<{ supplier: string }>("alice", 1, s)?.analysis.supplier).toBe("A的");
    expect(saveDraft("", { mode: "manual", hadPhoto: false, analysis: {} }, 0, s)).toBe(false);
  });
  it("幾分鐘前／幾小時前／幾天前", () => {
    expect(draftAgeLabel(0, 30_000)).toBe("剛剛");
    expect(draftAgeLabel(0, 5 * 60_000)).toBe("5 分鐘前");
    expect(draftAgeLabel(0, 3 * 3_600_000)).toBe("3 小時前");
    expect(draftAgeLabel(0, 48 * 3_600_000)).toBe("2 天前");
  });
});
