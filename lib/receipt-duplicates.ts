import type { ReceiptRecord } from "@/lib/types";

// 同一張進貨單被輸入兩次，庫存會加兩次。入庫前跟「最近進貨單」比對，找出可能重複的那一張。

export type DuplicateReason = "invoice" | "same-day-total";

export interface DuplicateMatch {
  receipt: ReceiptRecord;
  reason: DuplicateReason;
}

const norm = (value: string | undefined | null) => (value ?? "").replace(/\s+/g, "").toLowerCase();

export function findDuplicateReceipt(
  receipts: ReceiptRecord[],
  candidate: { invoiceNumber?: string; purchaseDate?: string; supplier?: string; totalAmount?: number },
): DuplicateMatch | null {
  const invoice = norm(candidate.invoiceNumber);
  // 單據號碼一樣（而且有填）：最可靠的重複訊號。
  if (invoice) {
    const hit = receipts.find((r) => norm(r.invoiceNumber) === invoice);
    if (hit) return { receipt: hit, reason: "invoice" };
  }
  // 沒有單據號碼可比：同一天、同供應商、同總額，也很可能是同一張。
  const supplier = norm(candidate.supplier);
  if (candidate.purchaseDate && supplier && typeof candidate.totalAmount === "number" && candidate.totalAmount > 0) {
    const hit = receipts.find((r) => r.purchaseDate === candidate.purchaseDate && norm(r.supplier) === supplier && r.totalAmount === candidate.totalAmount);
    if (hit) return { receipt: hit, reason: "same-day-total" };
  }
  return null;
}

export function describeDuplicate(match: DuplicateMatch): string {
  const r = match.receipt;
  const who = r.supplier || "未填供應商";
  const when = r.purchaseDate || "日期未填";
  return match.reason === "invoice"
    ? `單據號碼 ${r.invoiceNumber} 已經輸入過：${who}、${when}、${r.lines.length} 項。`
    : `${when} 同一家供應商「${who}」、同樣金額的進貨單已經輸入過（${r.lines.length} 項）。`;
}
