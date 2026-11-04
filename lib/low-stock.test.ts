import { describe, expect, it } from "vitest";
import { getLowStockReason, lowStockReasonLabel } from "./inventory";

const base = { usageForecastEnabled: false, estimatedUsage: undefined, usagePeriod: undefined } as const;

describe("getLowStockReason：少於安全庫存才算低庫存", () => {
  it("少於安全庫存 → 低庫存", () => {
    expect(getLowStockReason({ ...base, quantity: 3, safetyStock: 6 })).toBe("safety");
    expect(getLowStockReason({ ...base, quantity: 0.5, safetyStock: 1 })).toBe("safety");
  });
  it("剛好等於安全庫存 → 不算低庫存", () => {
    expect(getLowStockReason({ ...base, quantity: 1, safetyStock: 1 })).toBeNull();
    expect(getLowStockReason({ ...base, quantity: 0.5, safetyStock: 0.5 })).toBeNull();
  });
  it("安全庫存設0 → 數量0也不提醒", () => {
    expect(getLowStockReason({ ...base, quantity: 0, safetyStock: 0 })).toBeNull();
  });
  it("預估用量：少於一個週期的用量才提醒，等於安全庫存不影響", () => {
    const forecast = { usageForecastEnabled: true, estimatedUsage: 2, usagePeriod: "daily" } as const;
    expect(getLowStockReason({ ...forecast, quantity: 1, safetyStock: 1 })).toBe("forecast");
    expect(getLowStockReason({ ...forecast, quantity: 1, safetyStock: 3 })).toBe("both");
    expect(getLowStockReason({ ...forecast, quantity: 2, safetyStock: 2 })).toBeNull();
  });
  it("文字跟規則一致", () => {
    expect(lowStockReasonLabel("safety")).toBe("低於安全庫存");
  });
});
