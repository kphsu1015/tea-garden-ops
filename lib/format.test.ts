import { describe, expect, it } from "vitest";
import { formatNumber, formatSignedNumber, formatTaipeiDateLabel, getTaipeiHour, greetingForHour } from "./format";

describe("formatNumber", () => {
  it("整數不顯示小數點，0.5等小數照實顯示", () => {
    expect(formatNumber(3)).toBe("3");
    expect(formatNumber(0.5)).toBe("0.5");
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(1200)).toBe("1,200");
  });
  it("差異數量帶正負號，可顯示0.5", () => {
    expect(formatSignedNumber(0.5)).toBe("+0.5");
    expect(formatSignedNumber(-1.5)).toBe("-1.5");
    expect(formatSignedNumber(0)).toBe("0");
  });
});

describe("greetingForHour", () => {
  it("5:00-11:59 顯示早安", () => {
    expect(greetingForHour(5)).toBe("早安");
    expect(greetingForHour(11)).toBe("早安");
  });
  it("12:00-17:59 顯示午安", () => {
    expect(greetingForHour(12)).toBe("午安");
    expect(greetingForHour(17)).toBe("午安");
  });
  it("18:00-4:59 顯示晚安", () => {
    expect(greetingForHour(18)).toBe("晚安");
    expect(greetingForHour(23)).toBe("晚安");
    expect(greetingForHour(0)).toBe("晚安");
    expect(greetingForHour(4)).toBe("晚安");
  });
});

describe("getTaipeiHour", () => {
  it("以Asia/Taipei時區判斷小時，不受伺服器本地時區影響", () => {
    // 2026-01-01T09:30:00Z 是UTC時間；Taipei為UTC+8，換算後應該是17:30。
    const hour = getTaipeiHour(new Date("2026-01-01T09:30:00Z"));
    expect(hour).toBe(17);
  });
});

describe("formatTaipeiDateLabel", () => {
  it("格式為「YYYY年M月D日 · 星期X」", () => {
    const label = formatTaipeiDateLabel(new Date("2026-01-01T09:30:00Z"));
    expect(label).toMatch(/^2026年1月1日 · 星期/);
  });
});
