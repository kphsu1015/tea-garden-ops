import { describe, expect, it } from "vitest";
import type { PurchaseRequest } from "./types";
import { ageInfo, canEditOwnRequest, daysSince, filterRequests, sortDone } from "./purchases";

const req = (id: string, over: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  id, itemName: "醬油", quantity: 2, unit: "瓶", priority: "一般", status: "待確認", requester: "王管家", requestedAt: "2026-11-01 10:00",
  requesterId: "u1", createdAtIso: "2026-11-01T02:00:00Z", updatedAtIso: "2026-11-01T02:00:00Z", ...over,
});
const NOW = new Date("2026-11-09T04:00:00Z");

describe("daysSince（台北日期）", () => {
  it("同一天是 0，前一天晚上到隔天早上是 1", () => {
    expect(daysSince("2026-11-09T01:00:00Z", NOW)).toBe(0);
    expect(daysSince("2026-11-08T16:30:00Z", NOW)).toBe(0); // UTC 16:30 已經是台北 11/09 00:30，跟 NOW 同一天
    expect(daysSince("2026-11-08T15:30:00Z", NOW)).toBe(1); // 台北 11/08 23:30，昨天晚上
    expect(daysSince("2026-11-08T05:00:00Z", NOW)).toBe(1);
  });
  it("沒有時間或格式錯誤回傳 null", () => {
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince("壞掉", NOW)).toBeNull();
  });
});

describe("ageInfo", () => {
  it("待確認：2 天以上才顯示，7 天以上標為拖太久", () => {
    expect(ageInfo(req("a", { createdAtIso: "2026-11-09T01:00:00Z" }), NOW)).toBeNull();
    expect(ageInfo(req("a", { createdAtIso: "2026-11-06T02:00:00Z" }), NOW)).toEqual({ text: "已等 3 天還沒處理", stale: false });
    expect(ageInfo(req("a", { createdAtIso: "2026-11-01T02:00:00Z" }), NOW)?.stale).toBe(true);
  });
  it("已訂購／已到貨看最後更新時間，已入庫與暫緩不顯示", () => {
    expect(ageInfo(req("a", { status: "已訂購", updatedAtIso: "2026-11-05T02:00:00Z" }), NOW)?.text).toBe("已訂購，4 天沒有更新");
    expect(ageInfo(req("a", { status: "已到貨", updatedAtIso: "2026-11-05T02:00:00Z" }), NOW)?.text).toBe("已到貨，4 天沒有更新");
    expect(ageInfo(req("a", { status: "已入庫" }), NOW)).toBeNull();
    expect(ageInfo(req("a", { status: "暫緩" }), NOW)).toBeNull();
  });
});

describe("filterRequests", () => {
  const list = [req("a"), req("b", { itemName: "洗衣精", priority: "急件", requester: "林管家", requesterId: "u2", note: "客房用完了" })];
  it("搜尋品項、提出人、備註", () => {
    const f = (query: string) => filterRequests(list, { query, onlyUrgent: false, onlyMineId: null }).map((r) => r.id);
    expect(f("洗衣")).toEqual(["b"]);
    expect(f("王管家")).toEqual(["a"]);
    expect(f("客房")).toEqual(["b"]);
    expect(f("")).toEqual(["a", "b"]);
  });
  it("只看急件、只看我提出的", () => {
    expect(filterRequests(list, { query: "", onlyUrgent: true, onlyMineId: null }).map((r) => r.id)).toEqual(["b"]);
    expect(filterRequests(list, { query: "", onlyUrgent: false, onlyMineId: "u1" }).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("canEditOwnRequest", () => {
  it("只有本人、而且還在待確認", () => {
    expect(canEditOwnRequest(req("a"), "u1")).toBe(true);
    expect(canEditOwnRequest(req("a"), "u2")).toBe(false);
    expect(canEditOwnRequest(req("a", { status: "已訂購" }), "u1")).toBe(false);
    expect(canEditOwnRequest(req("a"), null)).toBe(false);
  });
});

describe("sortDone", () => {
  it("已處理的依最後更新時間新到舊", () => {
    const sorted = sortDone([req("old", { updatedAtIso: "2026-11-01T00:00:00Z" }), req("new", { updatedAtIso: "2026-11-08T00:00:00Z" })]);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
  });
});
