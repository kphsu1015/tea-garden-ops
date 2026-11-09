import { describe, expect, it } from "vitest";
import { mapNoteRow } from "./shared-records";

const base = {
  id: "n1",
  category: "餐飲",
  content: "明天早餐多備 8 份",
  important: true,
  created_at: "2026-11-09T01:00:00.000Z",
  author_id: "u1",
  resolved_at: null,
  edited_at: null,
  staff_profiles: { display_name: "王管家" },
  resolver: null,
};

describe("mapNoteRow（交接留言）", () => {
  it("未處理、沒編輯過：處理與編輯欄位都是空的", () => {
    const note = mapNoteRow(base);
    expect(note.authorId).toBe("u1");
    expect(note.author).toBe("王管家");
    expect(note.resolvedAt).toBeNull();
    expect(note.resolvedBy).toBeNull();
    expect(note.editedAt).toBeNull();
  });

  it("已處理：帶出處理人與時間", () => {
    const note = mapNoteRow({ ...base, resolved_at: "2026-11-09T03:00:00.000Z", resolver: [{ display_name: "林管家" }] });
    expect(note.resolvedAt).toBeTruthy();
    expect(note.resolvedBy).toBe("林管家");
  });

  it("已處理但查不到處理人：顯示破折號，不會是空白", () => {
    const note = mapNoteRow({ ...base, resolved_at: "2026-11-09T03:00:00.000Z", resolver: null });
    expect(note.resolvedBy).toBe("—");
  });

  it("編輯過：有編輯時間", () => {
    expect(mapNoteRow({ ...base, edited_at: "2026-11-09T02:00:00.000Z" }).editedAt).toBeTruthy();
  });

  it("不認得的分類退回「重要公告」", () => {
    expect(mapNoteRow({ ...base, category: "不存在" }).category).toBe("重要公告");
  });
});
