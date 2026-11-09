import { describe, expect, it } from "vitest";
import { collectSuppliers } from "./receipt-suppliers";

describe("collectSuppliers", () => {
  it("進貨單出現越多次越前面，庫存品項的供應商也算進來", () => {
    const r = collectSuppliers([{ supplier: "開元" }, { supplier: "開元" }, { supplier: "台新餐飲設備" }], [{ supplier: "好鄰居" }, { supplier: "好鄰居" }]);
    expect(r.frequent).toEqual(["開元", "台新餐飲設備", "好鄰居"]);
    expect(r.all).toEqual(["開元", "台新餐飲設備", "好鄰居"]);
  });
  it("空白、大小寫與空格不同的寫法視為同一家，只留第一個看到的寫法", () => {
    const r = collectSuppliers([{ supplier: " 開元 " }, { supplier: "開 元" }, { supplier: "" }, { supplier: null }, {}], []);
    expect(r.all).toEqual(["開元"]);
  });
  it("常用只取前幾家，全部清單不截斷", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const r = collectSuppliers(names.map((supplier) => ({ supplier })), [], 3);
    expect(r.frequent).toHaveLength(3);
    expect(r.all).toHaveLength(8);
  });
  it("完全沒有資料時是空清單", () => {
    expect(collectSuppliers([], [])).toEqual({ frequent: [], all: [] });
  });
});
