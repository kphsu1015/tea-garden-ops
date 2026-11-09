import { describe, expect, it } from "vitest";
import { purchaseLinesToCsv, sortReportLines, summarizeLines, type PurchaseReportLine } from "./purchase-report";

const line = (id: string, over: Partial<PurchaseReportLine> = {}): PurchaseReportLine => ({
  receiptId: "r1", purchaseDate: "2026-11-02", supplier: "好鄰居", invoiceNumber: null, status: "stocked", receiptTotalAmount: null,
  lineId: id, itemName: "豆漿", category: "食材", quantity: 2, unit: "瓶", unitPrice: 30, totalPrice: 60, effectiveAmount: 60, ...over,
});

describe("sortReportLines", () => {
  it("金額由大到小，金額空白的永遠排最後", () => {
    const sorted = sortReportLines([line("a", { effectiveAmount: 10 }), line("b", { effectiveAmount: null }), line("c", { effectiveAmount: 99 })], "amount", "desc");
    expect(sorted.map((l) => l.lineId)).toEqual(["c", "a", "b"]);
    const asc = sortReportLines([line("a", { effectiveAmount: 10 }), line("b", { effectiveAmount: null }), line("c", { effectiveAmount: 99 })], "amount", "asc");
    expect(asc.map((l) => l.lineId)).toEqual(["a", "c", "b"]);
  });
  it("日期排序、同值維持原順序", () => {
    const sorted = sortReportLines([line("a", { purchaseDate: "2026-11-05" }), line("b", { purchaseDate: "2026-11-02" }), line("c", { purchaseDate: "2026-11-02" })], "date", "asc");
    expect(sorted.map((l) => l.lineId)).toEqual(["b", "c", "a"]);
  });
});

describe("summarizeLines", () => {
  it("合計金額、單據數，金額空白的另外計數", () => {
    const s = summarizeLines([line("a", { effectiveAmount: 60.5 }), line("b", { receiptId: "r2", effectiveAmount: 40 }), line("c", { effectiveAmount: null })]);
    expect(s).toEqual({ lineCount: 3, receiptCount: 2, amount: 100.5, incompleteCount: 1 });
  });
});

describe("purchaseLinesToCsv", () => {
  it("有 BOM、供應商空白顯示未標示、金額空白留空", () => {
    const csv = purchaseLinesToCsv([line("a", { supplier: null, effectiveAmount: null, unitPrice: null })]);
    expect(csv.startsWith("\uFEFF進貨日期,供應商")).toBe(true);
    expect(csv).toContain("2026-11-02,未標示供應商,,豆漿,食材,2,瓶,,");
  });
  it("品項名稱以 = 開頭不會變公式", () => {
    expect(purchaseLinesToCsv([line("a", { itemName: "=1+1" })])).toContain("'=1+1");
  });
});
