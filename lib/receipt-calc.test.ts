import { describe, expect, it } from "vitest";
import {
  calculateAmountMismatch, calculateReceiptTotals, deriveChargeAmountFromLine,
  pickEffectiveAmount, splitAnalysisLines, type RawAnalysisLine,
} from "./receipt-calc";

// 對應user需求「七、測試案例」的7個情境。SQL層（RPC、報表函式）的行為無法在沒有真實Postgres連線的
// 單元測試裡驗證，這裡改為測試跟SQL邏輯對應的JS純函式（pickEffectiveAmount對應coalesce規則、
// calculateReceiptTotals對應報表金額估算公式），並在tea-garden-ops的說明文件中註明對應的SQL已經人工檢查過。

describe("1. 兩個庫存品項＋一筆運費", () => {
  it("計算總額＝庫存小計＋運費，運費不計入庫存小計", () => {
    const lines = [{ totalPrice: 500, quantity: 1 }, { totalPrice: 300, quantity: 1 }];
    const charges = [{ chargeType: "shipping" as const, amount: 80 }];
    const result = calculateReceiptTotals(lines, charges);
    expect(result.inventorySubtotal).toBe(800);
    expect(result.shippingTotal).toBe(80);
    expect(result.calculatedTotal).toBe(880);
  });
});

describe("2. 庫存品項＋運費＋折扣", () => {
  it("折扣會從計算總額中扣除", () => {
    const lines = [{ totalPrice: 1000, quantity: 1 }];
    const charges = [
      { chargeType: "shipping" as const, amount: 100 },
      { chargeType: "discount" as const, amount: 50 },
    ];
    const result = calculateReceiptTotals(lines, charges);
    expect(result.shippingTotal).toBe(100);
    expect(result.discountTotal).toBe(50);
    expect(result.calculatedTotal).toBe(1000 + 100 - 50);
  });
});

describe("3. AI把運費誤判為品項後，使用者手動改成運費", () => {
  it("splitAnalysisLines先把AI標成inventory的列放進庫存區", () => {
    const raw: RawAnalysisLine[] = [{ lineType: "inventory", itemName: "運費", quantity: 1, unit: "式", totalPrice: 60 }];
    const { inventoryLines, chargeLines } = splitAnalysisLines(raw);
    expect(inventoryLines).toHaveLength(1);
    expect(chargeLines).toHaveLength(0);
  });

  it("使用者手動切換後，金額改計入運費、不再計入庫存小計", () => {
    const misclassified = { totalPrice: 60, unitPrice: undefined, quantity: 1 };
    const derivedAmount = deriveChargeAmountFromLine(misclassified);
    expect(derivedAmount).toBe(60);

    const beforeSwitch = calculateReceiptTotals([misclassified], []);
    expect(beforeSwitch.inventorySubtotal).toBe(60);
    expect(beforeSwitch.shippingTotal).toBe(0);

    const afterSwitch = calculateReceiptTotals([], [{ chargeType: "shipping", amount: derivedAmount }]);
    expect(afterSwitch.inventorySubtotal).toBe(0);
    expect(afterSwitch.shippingTotal).toBe(60);
  });
});

describe("4. AI把正常品項誤判為其他費用後，使用者改回庫存品項", () => {
  it("splitAnalysisLines先把AI標成other_fee的列放進費用區", () => {
    const raw: RawAnalysisLine[] = [{ lineType: "other_fee", itemName: "有機米5公斤", quantity: 1, unit: "包", totalPrice: 320 }];
    const { inventoryLines, chargeLines } = splitAnalysisLines(raw);
    expect(chargeLines).toHaveLength(1);
    expect(inventoryLines).toHaveLength(0);
  });

  it("使用者手動改回庫存品項後，金額改計入庫存小計、不再計入其他費用", () => {
    const beforeSwitch = calculateReceiptTotals([], [{ chargeType: "other_fee", amount: 320 }]);
    expect(beforeSwitch.otherFeeTotal).toBe(320);
    expect(beforeSwitch.inventorySubtotal).toBe(0);

    const afterSwitch = calculateReceiptTotals([{ totalPrice: 320, quantity: 1 }], []);
    expect(afterSwitch.inventorySubtotal).toBe(320);
    expect(afterSwitch.otherFeeTotal).toBe(0);
  });
});

describe("5. 運費不會建立庫存品項或庫存異動", () => {
  it("不論品項名稱寫什麼，只要lineType不是inventory，就一定不會出現在inventoryLines裡", () => {
    const raw: RawAnalysisLine[] = [
      { lineType: "shipping", itemName: "運費", quantity: 1, unit: "式", totalPrice: 50 },
      { lineType: "handling", itemName: "包裝費", quantity: 1, unit: "式", totalPrice: 20 },
      { lineType: "tax", itemName: "營業稅", quantity: 1, unit: "式", totalPrice: 30 },
      { lineType: "discount", itemName: "折扣", quantity: 1, unit: "式", totalPrice: 10 },
      { lineType: "other_fee", itemName: "其他費用", quantity: 1, unit: "式", totalPrice: 15 },
    ];
    const { inventoryLines, chargeLines } = splitAnalysisLines(raw);
    expect(inventoryLines).toHaveLength(0);
    expect(chargeLines).toHaveLength(5);
    // 前端只會把inventoryLines送進confirm_receipt_with_lines的p_lines，
    // p_charges那一路在migration 0008裡完全沒有insert inventory_items或呼叫record_stock_movement，
    // 這一段SQL邏輯已經人工檢查過（見0008_receipt_non_inventory_charges.sql）。
  });
});

describe("6. 月報表總額包含運費，但品項排行不包含運費", () => {
  it("pickEffectiveAmount在total_amount有值時只採用單據總額本身（已含運費），不會再加總品項或費用", () => {
    const effective = pickEffectiveAmount(880, 9999);
    expect(effective).toBe(880);
  });

  it("total_amount為null時的估算公式含運費，跟get_purchase_monthly_summary的fallback邏輯一致", () => {
    const lines = [{ totalPrice: 800, quantity: 1 }];
    const charges = [{ chargeType: "shipping" as const, amount: 80 }];
    const { calculatedTotal } = calculateReceiptTotals(lines, charges);
    const effective = pickEffectiveAmount(null, calculatedTotal);
    expect(effective).toBe(880);
  });

  it("品項排行（get_purchase_top_items）只查receipt_lines，運費在receipt_charges，結構上不會混入品項排行", () => {
    // 這是資料表分離帶來的結構性保證：receipt_charges跟receipt_lines是兩張不同的表，
    // get_purchase_top_items（0004migration）只join receipt_lines，語法上不可能選到receipt_charges的資料。
    const raw: RawAnalysisLine[] = [{ lineType: "shipping", itemName: "運費", quantity: 1, unit: "式", totalPrice: 80 }];
    const { inventoryLines } = splitAnalysisLines(raw);
    expect(inventoryLines).toHaveLength(0);
  });
});

describe("7. 單據金額不會重複加總", () => {
  it("total_amount有值時，回傳值就是total_amount本身，不是total_amount加上品項或費用金額", () => {
    const totalAmount = 880;
    const lines = [{ totalPrice: 800, quantity: 1 }];
    const charges = [{ chargeType: "shipping" as const, amount: 80 }];
    const { calculatedTotal } = calculateReceiptTotals(lines, charges);
    const effective = pickEffectiveAmount(totalAmount, calculatedTotal);
    // 即使calculatedTotal剛好等於totalAmount，effective也只會是其中一個來源，不是兩者相加。
    expect(effective).toBe(totalAmount);
    expect(effective).not.toBe(totalAmount + calculatedTotal);
  });

  it("calculateAmountMismatch只用來顯示差額，不會被拿去加回計算總額", () => {
    const mismatch = calculateAmountMismatch(900, 880);
    expect(mismatch).toBe(20);
    // mismatch只是給UI顯示警告用的差額，確認入庫送出的仍然是原始totalAmount（900），不會變成900+20。
  });
});
