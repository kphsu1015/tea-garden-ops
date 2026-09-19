import type { AssignableStaffRole, StaffProfile, StaffRole } from "@/lib/types";

// 統一的角色中文顯示，所有畫面都應該從這裡取用，不要各處自己硬寫文字。
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  admin: "管理員",
  purchaser: "訂貨管家",
  housekeeper: "管家",
  viewer: "待指定角色", // 已移除的舊角色，不對外顯示「查看者」，需要管理員重新指定
};

export const ASSIGNABLE_STAFF_ROLES: AssignableStaffRole[] = ["admin", "purchaser", "housekeeper"];

export function staffRoleLabel(role: StaffRole): string {
  return STAFF_ROLE_LABELS[role] ?? role;
}

export function isAssignableStaffRole(role: string): role is AssignableStaffRole {
  return role === "admin" || role === "purchaser" || role === "housekeeper";
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
