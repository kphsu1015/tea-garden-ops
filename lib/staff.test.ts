import { describe, expect, it } from "vitest";
import { adminChangeBlockedReason, countActiveAdmins, filterStaff, hasPlaceholderName } from "./staff";
import type { StaffProfile } from "./types";

const m = (id: string, over: Partial<StaffProfile> = {}): StaffProfile => ({ id, displayName: `員工${id}`, email: `${id}@x.com`, role: "housekeeper", active: true, createdAt: "2026-01-01", ...over });

describe("hasPlaceholderName", () => {
  it("姓名是 Email 或空白算還沒設定姓名", () => {
    expect(hasPlaceholderName(m("a", { displayName: "a@x.com" }))).toBe(true);
    expect(hasPlaceholderName(m("a", { displayName: "  " }))).toBe(true);
    expect(hasPlaceholderName(m("a", { displayName: "王管家" }))).toBe(false);
  });
});

describe("filterStaff", () => {
  const staff = [m("a", { displayName: "王管家" }), m("b", { displayName: "林小姐", active: false }), m("c", { displayName: "陳先生", email: "chen@tea.com" })];
  it("依狀態篩選", () => {
    expect(filterStaff(staff, "active", "").map((s) => s.id)).toEqual(["a", "c"]);
    expect(filterStaff(staff, "inactive", "").map((s) => s.id)).toEqual(["b"]);
    expect(filterStaff(staff, "all", "")).toHaveLength(3);
  });
  it("搜尋姓名或 Email，不分大小寫", () => {
    expect(filterStaff(staff, "all", "CHEN").map((s) => s.id)).toEqual(["c"]);
    expect(filterStaff(staff, "all", "王").map((s) => s.id)).toEqual(["a"]);
  });
});

describe("最後一位管理員防護", () => {
  it("只有一位使用中的管理員時，不能降級或停用", () => {
    const staff = [m("a", { role: "admin" }), m("b", { role: "admin", active: false }), m("c")];
    expect(countActiveAdmins(staff)).toBe(1);
    expect(adminChangeBlockedReason(staff[0], staff, "x")).toContain("唯一的管理員");
  });
  it("有兩位管理員時，可以改別人，但不能改自己", () => {
    const staff = [m("a", { role: "admin" }), m("b", { role: "admin" })];
    expect(adminChangeBlockedReason(staff[1], staff, "a")).toBeNull();
    expect(adminChangeBlockedReason(staff[0], staff, "a")).toContain("自己");
  });
  it("不是管理員的人不受限制", () => {
    const staff = [m("a", { role: "admin" }), m("b")];
    expect(adminChangeBlockedReason(staff[1], staff, "a")).toBeNull();
  });
});
