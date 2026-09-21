// 進貨單AI辨識結果的純函式：分類（庫存品項／非庫存費用）與金額試算。
// 抽成獨立檔案是為了讓這些規則可以被單元測試覆蓋，不用整個渲染ReceiptScanner元件。
import type { ReceiptChargeType } from "@/lib/types";

export type RawLineType = "inventory" | ReceiptChargeType;

export interface RawAnalysisLine {
  lineType?: RawLineType;
  itemName: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  category?: string;
}

// AI辨識沒有給lineType（例如舊版回應或demo資料缺欄位）時，一律視為庫存品項，維持向下相容。
export function splitAnalysisLines(lines: RawAnalysisLine[]): { inventoryLines: RawAnalysisLine[]; chargeLines: RawAnalysisLine[] } {
  const inventoryLines = lines.filter((line) => !line.lineType || line.lineType === "inventory");
  const chargeLines = lines.filter((line) => Boolean(line.lineType) && line.lineType !== "inventory");
  return { inventoryLines, chargeLines };
}

export interface CalcInventoryLine {
  totalPrice?: number;
  unitPrice?: number;
  quantity: number;
}

export interface CalcCharge {
  chargeType: ReceiptChargeType;
  amount: number;
}

export interface ReceiptCalcResult {
  inventorySubtotal: number;
  shippingTotal: number;
  otherFeeTotal: number;
  taxTotal: number;
  discountTotal: number;
  calculatedTotal: number;
}

// 庫存品項小計＋運費＋其他費用＋稅額－折扣＝計算總額。只用來跟單據總額比對，絕不用來覆蓋或推測單據總額。
export function calculateReceiptTotals(lines: CalcInventoryLine[], charges: CalcCharge[]): ReceiptCalcResult {
  const inventorySubtotal = lines.reduce((sum, line) => sum + (line.totalPrice ?? ((line.unitPrice ?? 0) * (line.quantity || 0))), 0);
  const shippingTotal = charges.filter((c) => c.chargeType === "shipping").reduce((sum, c) => sum + c.amount, 0);
  const otherFeeTotal = charges.filter((c) => c.chargeType === "handling" || c.chargeType === "other_fee").reduce((sum, c) => sum + c.amount, 0);
  const taxTotal = charges.filter((c) => c.chargeType === "tax").reduce((sum, c) => sum + c.amount, 0);
  const discountTotal = charges.filter((c) => c.chargeType === "discount").reduce((sum, c) => sum + c.amount, 0);
  const calculatedTotal = inventorySubtotal + shippingTotal + otherFeeTotal + taxTotal - discountTotal;
  return { inventorySubtotal, shippingTotal, otherFeeTotal, taxTotal, discountTotal, calculatedTotal };
}

// 單據總額與計算總額的差額（四捨五入到分），只用來顯示警告，不會自動修正任何一邊的數字。
export function calculateAmountMismatch(totalAmount: number | undefined, calculatedTotal: number): number {
  if (typeof totalAmount !== "number") return 0;
  return Math.round((totalAmount - calculatedTotal) * 100) / 100;
}

// 一筆列被使用者從「庫存品項」手動改成「其他費用」時，沿用原本的金額，不用重新輸入。
export function deriveChargeAmountFromLine(line: { totalPrice?: number; unitPrice?: number; quantity: number }): number {
  return line.totalPrice ?? (line.unitPrice ? line.unitPrice * line.quantity : 0);
}

// 報表／單據核對用的金額估算規則：receipts.total_amount有值時一律只採用它，絕不會再疊加品項或費用金額；
// 只有total_amount是null時才會退回用「庫存品項小計＋非折扣費用－折扣」估算，兩種來源不會同時採用，避免重複計算。
export function pickEffectiveAmount(totalAmount: number | null | undefined, fallbackTotal: number): number {
  return typeof totalAmount === "number" ? totalAmount : fallbackTotal;
}
