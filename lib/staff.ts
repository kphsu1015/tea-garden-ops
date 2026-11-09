import type { AssignableStaffRole, StaffProfile, StaffRole } from "@/lib/types";

// 統一的角色中文顯示，所有畫面都應該從這裡取用，不要各處自己硬寫文字。
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  admin: "管理員",
  purchaser: "訂貨管家",
  housekeeper: "管家",
  viewer: "待指定角色", // 已移除的舊角色，不對外顯示「查看者」，需要管理員重新指定
};

export const ASSIGNABLE_STAFF_ROLES: AssignableStaffRole[] = ["admin", "purchaser", "housekeeper"];

// 「新增員工」表單只能選這兩個角色；管理員角色不在這個列表裡，避免誤邀成管理員。
export const INVITABLE_STAFF_ROLES: Array<"purchaser" | "housekeeper"> = ["purchaser", "housekeeper"];

export function staffRoleLabel(role: StaffRole): string {
  return STAFF_ROLE_LABELS[role] ?? role;
}

export function isAssignableStaffRole(role: string): role is AssignableStaffRole {
  return role === "admin" || role === "purchaser" || role === "housekeeper";
}

// 邀請「新員工」（第一次建立staff_profiles）只能指定訂貨管家或管家；管理員帳號一律由現有admin
// 透過編輯既有員工角色來指定，不透過這個新增流程建立，避免有人被誤邀成管理員。
export function isInvitableStaffRole(role: string): role is "purchaser" | "housekeeper" {
  return role === "purchaser" || role === "housekeeper";
}

type StaffProfileRow = {
  id: string;
  display_name: string;
  email: string;
  role: StaffRole;
  active: boolean;
  created_at: string;
};

export function mapStaffRow(row: StaffProfileRow): StaffProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  };
}

// ===== 員工管理頁用：角色說明、搜尋篩選、最後一位管理員防護 =====

// 三種角色各自能做什麼。內容是照目前程式裡實際的權限寫的（畫面按鈕開關與資料庫政策），改權限時要一起改這裡。
export const STAFF_ROLE_PERMISSIONS: Array<{ role: AssignableStaffRole; can: string; cannot: string }> = [
  { role: "admin", can: "所有功能：管理員工與權限、管理品項、處理採購、看進貨報表、修改進貨單金額、刪除與復原進貨單、刪除交接留言。", cannot: "" },
  { role: "purchaser", can: "管理品項（新增、編輯、停用、刪除）、處理採購需求、看進貨報表、盤點與記錄異動。", cannot: "不能管理員工、不能修改或刪除進貨單、不能刪除交接留言。" },
  { role: "housekeeper", can: "盤點與記錄異動、提出採購需求、寫交接留言與標記已處理。", cannot: "不能新增或編輯品項、不能看進貨報表、不能管理員工。" },
];

export const COMMON_STAFF_ABILITIES = "所有人都可以：看庫存與異動紀錄、提出採購需求、寫交接留言並標記已處理。";

// 姓名欄還是 Email（還沒設定姓名）的人，列表上要提醒管理員補上。
export function hasPlaceholderName(member: Pick<StaffProfile, "displayName" | "email">): boolean {
  const name = member.displayName.trim();
  return name === "" || name.includes("@") || name.toLowerCase() === member.email.toLowerCase();
}

export function countActiveAdmins(staff: Array<Pick<StaffProfile, "role" | "active">>): number {
  return staff.filter((m) => m.role === "admin" && m.active).length;
}

export type StaffStatusFilter = "active" | "inactive" | "all";

export function filterStaff(staff: StaffProfile[], status: StaffStatusFilter, query: string): StaffProfile[] {
  const q = query.trim().toLowerCase();
  return staff.filter((m) =>
    (status === "all" || (status === "active" ? m.active : !m.active)) &&
    (!q || `${m.displayName} ${m.email}`.toLowerCase().includes(q)),
  );
}

// 這個人現在還能不能被降級／停用？回傳 null 表示可以，否則回傳原因（畫面直接顯示）。
// 資料庫另外有觸發器擋「最後一位管理員」，這裡只是讓畫面提早說清楚。
export function adminChangeBlockedReason(member: Pick<StaffProfile, "id" | "role" | "active">, staff: Array<Pick<StaffProfile, "role" | "active">>, currentUserId: string | null): string | null {
  if (member.role !== "admin" || !member.active) return null;
  if (countActiveAdmins(staff) <= 1) return "這是唯一的管理員。要先指定另一位管理員，才能降級或停用。";
  if (member.id === currentUserId) return "不能修改自己的管理員身分，請其他管理員幫你改。";
  return null;
}
