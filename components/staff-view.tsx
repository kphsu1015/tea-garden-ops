"use client";

import { Check, LoaderCircle, Pencil, Plus, Power, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ASSIGNABLE_STAFF_ROLES, INVITABLE_STAFF_ROLES, staffRoleLabel } from "@/lib/staff";
import type { AssignableStaffRole, StaffProfile } from "@/lib/types";

export function StaffView({ canView, canManage, currentUserId }: { canView: boolean; canManage: boolean; currentUserId: string | null }) {
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AssignableStaffRole>("housekeeper");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [formNotice, setFormNotice] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<AssignableStaffRole>("housekeeper");
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/staff");
      const data = await response.json() as { staff?: StaffProfile[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取員工列表失敗");
      setStaff(data.staff || []);
      setDemo(Boolean(data.demo));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "讀取員工列表失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [canView]);

  const addStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSubmitting(true);
    setFormError("");
    setFormNotice("");
    try {
      const response = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, displayName: displayName.trim() || undefined, role }),
      });
      const data = await response.json() as { error?: string; invited?: boolean };
      if (!response.ok) throw new Error(data.error || "新增員工失敗");
      setEmail("");
      setDisplayName("");
      setRole("housekeeper");
      if (data.invited) {
        setFormNotice("這個Email還沒登入過，已寄出一次性「設定密碼」連結；對方點擊連結完成設定後，會自動成為正式員工。");
      } else {
        await refresh();
      }
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "新增員工失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  const runRowAction = async (id: string, action: () => Promise<Response>) => {
    setRowError(null);
    setRowBusyId(id);
    try {
      const response = await action();
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "操作失敗，請稍後再試。");
      await refresh();
      return true;
    } catch (reason) {
      setRowError({ id, message: reason instanceof Error ? reason.message : "操作失敗，請稍後再試。" });
      return false;
    } finally {
      setRowBusyId(null);
    }
  };

  const saveRole = async (id: string) => {
    const ok = await runRowAction(id, () => fetch(`/api/staff/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: editingRole }),
    }));
    if (ok) setEditingId(null);
  };

  const toggleActive = (member: StaffProfile) => runRowAction(member.id, () => fetch(`/api/staff/${member.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !member.active }),
  }));

  if (!canView) {
    return <><div className="section-header"><div><h1>員工與權限</h1><p>管理員工帳號、角色與啟用狀態。</p></div></div>
      <div className="warning-box"><span>• 此頁面僅管理員可以查看。</span></div>
    </>;
  }

  return <>
    <div className="section-header"><div><h1>員工與權限</h1><p>只有管理員可以新增員工、設定角色、停用及重新啟用員工。</p></div></div>
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，目前僅顯示示範資料，無法新增或修改員工。</span></div>}
    {error && <div className="error-box">{error}</div>}

    {canManage && <section className="settings-card staff-add-card">
      <header><h2>新增員工</h2><p>新員工只能指定訂貨管家或管家；管理員帳號請由現有管理員直接調整既有員工的角色。系統不會自動建立新的登入帳號，也不會給隱含的預設角色。</p></header>
      <form onSubmit={addStaff} className="staff-add-form">
        <label>員工Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@teagarden.local" disabled={submitting} /></label>
        <label>顯示名稱（可不填）<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：王管家" disabled={submitting} /></label>
        <label>角色<select value={role} onChange={(e) => setRole(e.target.value as AssignableStaffRole)} disabled={submitting}>{INVITABLE_STAFF_ROLES.map((r) => <option key={r} value={r}>{staffRoleLabel(r)}</option>)}</select></label>
        <button className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}新增員工</button>
      </form>
      {formError && <div className="error-box">{formError}</div>}
      {formNotice && <div className="setting-note">{formNotice}</div>}
    </section>}

    {loading ? <p>載入員工中…</p> : <div className="table-card"><table><thead><tr><th>姓名</th><th>Email</th><th>角色</th><th>狀態</th>{canManage && <th>操作</th>}</tr></thead><tbody>{staff.map((member) => {
      const editing = editingId === member.id;
      const busy = rowBusyId === member.id;
      return <tr key={member.id}>
        <td><strong>{member.displayName}</strong></td>
        <td>{member.email}</td>
        <td>{editing ? <select value={editingRole} onChange={(e) => setEditingRole(e.target.value as AssignableStaffRole)}>{ASSIGNABLE_STAFF_ROLES.map((r) => <option key={r} value={r}>{staffRoleLabel(r)}</option>)}</select> : staffRoleLabel(member.role)}</td>
        <td><span className={member.active ? "pill" : "pill pill-red"}>{member.active ? "使用中" : "已停用"}</span></td>
        {canManage && <td>
          <div className="row-actions">
            {editing ? <>
              <button aria-label="儲存角色" title="儲存角色" disabled={busy} onClick={() => saveRole(member.id)}><Check size={15} /></button>
              <button aria-label="取消編輯" title="取消編輯" onClick={() => setEditingId(null)}><X size={15} /></button>
            </> : <>
              <button aria-label={`編輯${member.displayName}角色`} title={`編輯${member.displayName}角色`} disabled={busy} onClick={() => { setEditingId(member.id); setEditingRole(member.role === "viewer" ? "housekeeper" : member.role); }}><Pencil size={15} /></button>
              <button aria-label={member.active ? `停用${member.displayName}` : `啟用${member.displayName}`} disabled={busy || (member.active && member.id === currentUserId)} title={member.active && member.id === currentUserId ? "無法停用自己的帳號" : (member.active ? `停用${member.displayName}` : `啟用${member.displayName}`)} onClick={() => toggleActive(member)}><Power size={15} /></button>
            </>}
          </div>
          {rowError?.id === member.id && <div className="error-box">{rowError.message}</div>}
        </td>}
      </tr>;
    })}</tbody></table></div>}
  </>;
}
