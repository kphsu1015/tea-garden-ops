"use client";

import { LoaderCircle, Mail, Plus, RefreshCw, Search, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "./use-dialog";
import {
  ASSIGNABLE_STAFF_ROLES, COMMON_STAFF_ABILITIES, INVITABLE_STAFF_ROLES, STAFF_ROLE_PERMISSIONS,
  adminChangeBlockedReason, countActiveAdmins, filterStaff, hasPlaceholderName, staffRoleLabel,
  type StaffStatusFilter,
} from "@/lib/staff";
import type { AssignableStaffRole, StaffProfile } from "@/lib/types";

type Invitation = { id: string; email: string; displayName: string | null; role: string; createdAt: string };
type Notice = { message: string; error?: boolean; undo?: () => Promise<void> };
type Editing = { id: string; name: string; role: AssignableStaffRole };
type Confirm =
  | { kind: "deactivate"; member: StaffProfile }
  | { kind: "role"; member: StaffProfile; name: string | null; role: AssignableStaffRole }
  | { kind: "cancel-invite"; invitation: Invitation };

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("zh-TW");

export function StaffView({ canView, canManage, currentUserId }: { canView: boolean; canManage: boolean; currentUserId: string | null }) {
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undoing, setUndoing] = useState(false);

  const [status, setStatus] = useState<StaffStatusFilter>("active");
  const [query, setQuery] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AssignableStaffRole>("housekeeper");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const [editing, setEditing] = useState<Editing | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [resentIds, setResentIds] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  // silent：操作完重新讀取時不要把整張表換成「載入中」，畫面才不會閃。
  const refresh = async (silent = false) => {
    const mine = ++seq.current;
    if (!silent) { setLoading(true); setError(""); }
    try {
      const response = await fetch("/api/staff");
      const data = await response.json() as { staff?: StaffProfile[]; invitations?: Invitation[]; demo?: boolean; error?: string };
      if (mine !== seq.current) return;
      if (!response.ok) throw new Error(data.error || "讀取員工列表失敗");
      setStaff(data.staff || []);
      setInvitations(data.invitations || []);
      setDemo(Boolean(data.demo));
      setLoaded(true);
      setError("");
    } catch (reason) {
      if (mine !== seq.current) return;
      // 操作成功後的重新讀取失敗也要講：畫面上的列表可能不是最新的，不能假裝同步了。
      setError(silent ? "剛剛的操作已經完成，但重新載入員工列表失敗，畫面上的資料可能不是最新的。" : (reason instanceof Error ? reason.message : "讀取員工列表失敗，請稍後再試。"));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
    // 只在權限變化時載入一次，之後由各操作自己重新讀取。
  }, [canView]);

  const activeAdmins = useMemo(() => countActiveAdmins(staff), [staff]);
  const counts = useMemo(() => ({
    active: filterStaff(staff, "active", query).length,
    inactive: filterStaff(staff, "inactive", query).length,
    all: filterStaff(staff, "all", query).length,
  }), [staff, query]);
  const shown = useMemo(() => filterStaff(staff, status, query), [staff, status, query]);

  const addStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSubmitting(true);
    setFormError("");
    try {
      const response = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, displayName: displayName.trim() || undefined, role }),
      });
      const data = await response.json() as { error?: string; invited?: boolean };
      if (!response.ok) throw new Error(data.error || "新增員工失敗");
      setEmail(""); setDisplayName(""); setRole("housekeeper"); setShowAdd(false);
      setNotice({ message: data.invited
        ? `已寄出設定密碼的信給 ${value}。對方點信裡的連結設定好密碼，就會自動成為正式員工；在那之前會列在下面的「已邀請」。`
        : `已新增 ${displayName.trim() || value}，角色是${staffRoleLabel(role)}。` });
      if (!data.invited) setStatus("active");
      await refresh(true);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "新增員工失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  // 對單一員工送 PATCH；成功回傳 undefined，失敗回傳錯誤訊息（顯示在該列）。
  const patchMember = async (id: string, body: Record<string, unknown>): Promise<string | undefined> => {
    setRowError(null);
    setRowBusyId(id);
    try {
      const response = await fetch(`/api/staff/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "操作失敗，請稍後再試。");
      await refresh(true);
      return undefined;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "操作失敗，請稍後再試。";
      setRowError({ id, message });
      return message;
    } finally {
      setRowBusyId(null);
    }
  };

  const startEdit = (member: StaffProfile) => {
    setRowError(null);
    setEditing({ id: member.id, name: member.displayName, role: member.role === "viewer" ? "housekeeper" : member.role });
  };

  const saveEdit = async (member: StaffProfile) => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setRowError({ id: member.id, message: "請輸入姓名。" }); return; }
    const nameChanged = name !== member.displayName;
    const roleChanged = editing.role !== member.role;
    if (!nameChanged && !roleChanged) { setEditing(null); return; }
    // 升成或降離管理員影響很大，先確認一次。
    if (roleChanged && (editing.role === "admin" || member.role === "admin")) {
      setConfirm({ kind: "role", member, name: nameChanged ? name : null, role: editing.role });
      return;
    }
    await applyEdit(member, nameChanged ? name : null, roleChanged ? editing.role : null);
  };

  const applyEdit = async (member: StaffProfile, name: string | null, nextRole: AssignableStaffRole | null): Promise<string | undefined> => {
    const body: Record<string, unknown> = {};
    if (name !== null) body.displayName = name;
    if (nextRole !== null) body.role = nextRole;
    const failure = await patchMember(member.id, body);
    if (failure) return failure;
    setEditing((current) => current?.id === member.id ? null : current);
    const parts = [name !== null ? "姓名" : "", nextRole !== null ? `角色（改成${staffRoleLabel(nextRole)}）` : ""].filter(Boolean).join("和");
    setNotice({ message: `已儲存 ${name ?? member.displayName} 的${parts}。` });
    return undefined;
  };

  const setActive = async (member: StaffProfile, active: boolean): Promise<string | undefined> => {
    const failure = await patchMember(member.id, { active });
    if (failure) return failure;
    setNotice(active
      ? { message: `已重新啟用 ${member.displayName}，對方可以再登入。` }
      : { message: `已停用 ${member.displayName}，對方無法再登入；他寫過的紀錄都會保留。`, undo: async () => { await setActive(member, true); } });
    return undefined;
  };

  const resendInvite = async (invitation: Invitation) => {
    setRowError(null);
    setRowBusyId(invitation.id);
    try {
      const response = await fetch(`/api/staff/invitations/${invitation.id}`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "重寄失敗");
      setResentIds((current) => new Set(current).add(invitation.id));
      setNotice({ message: `已重寄設定密碼的信給 ${invitation.email}。請對方也看一下垃圾信件匣。` });
    } catch (reason) {
      setRowError({ id: invitation.id, message: reason instanceof Error ? reason.message : "重寄失敗，請稍後再試。" });
    } finally {
      setRowBusyId(null);
    }
  };

  const cancelInvite = async (invitation: Invitation): Promise<string | undefined> => {
    try {
      const response = await fetch(`/api/staff/invitations/${invitation.id}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "取消失敗");
      setNotice({ message: `已取消對 ${invitation.email} 的邀請，對方點信裡的連結也不會成為員工。` });
      await refresh(true);
      return undefined;
    } catch (reason) {
      return reason instanceof Error ? reason.message : "取消失敗，請稍後再試。";
    }
  };

  const undo = async () => {
    if (!notice?.undo) return;
    setUndoing(true);
    try { await notice.undo(); } finally { setUndoing(false); }
  };

  if (!canView) {
    return <><div className="section-header"><div><h1>員工管理</h1><p>管理員工帳號、角色與啟用狀態。</p></div></div>
      <div className="warning-box"><span>• 此頁面僅管理員可以查看。</span></div>
    </>;
  }

  return <>
    <div className="section-header">
      <div><h1>員工管理</h1><p>只有管理員可以新增員工、設定角色、停用及重新啟用員工。</p></div>
      {canManage && !demo && <button type="button" className="primary-button" onClick={() => { setShowAdd((v) => !v); setFormError(""); }}><Plus size={18} />{showAdd ? "收起表單" : "新增員工"}</button>}
    </div>
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，目前僅顯示示範資料，無法新增或修改員工。</span></div>}
    {error && <div className="error-box inventory-notice" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => refresh()}><RefreshCw size={14} />重新載入</button></div>}
    {notice && <div className={notice.error ? "error-box inventory-notice" : "inventory-notice"} role={notice.error ? "alert" : "status"}>
      <span>{notice.message}</span>
      {notice.undo && <button type="button" className="text-button" onClick={undo} disabled={undoing}><Undo2 size={14} />{undoing ? "復原中…" : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setNotice(null)}><X size={14} /></button>
    </div>}

    <details className="movement-help"><summary>三種角色各自能做什麼</summary>
      <div className="staff-role-guide">{STAFF_ROLE_PERMISSIONS.map((r) => <div key={r.role}>
        <strong>{staffRoleLabel(r.role)}</strong>
        <p>{r.can}</p>
        {r.cannot && <p className="field-hint">{r.cannot}</p>}
      </div>)}</div>
      <p className="field-hint">{COMMON_STAFF_ABILITIES}</p>
    </details>

    {canManage && showAdd && <section className="settings-card staff-add-card">
      <header><h2>新增員工</h2><p>輸入對方的 Email 和角色。對方如果已經登入過本系統，會直接成為員工；第一次使用的人會收到一封設定密碼的信，設定好就能登入。新員工只能先設成訂貨管家或管家，要升成管理員請建立後再編輯角色。</p></header>
      <form onSubmit={addStaff} className="staff-add-form">
        <label>員工Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@teagarden.local" disabled={submitting} autoFocus /></label>
        <label>姓名（不填會顯示 Email）<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：王管家" disabled={submitting} /></label>
        <label>角色<select value={role} onChange={(e) => setRole(e.target.value as AssignableStaffRole)} disabled={submitting}>{INVITABLE_STAFF_ROLES.map((r) => <option key={r} value={r}>{staffRoleLabel(r)}</option>)}</select></label>
        <button className="primary-button" disabled={submitting || !email.trim()}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}{submitting ? "送出中…" : "新增員工"}</button>
      </form>
      {formError && <div className="error-box" role="alert">{formError}</div>}
    </section>}

    {canManage && invitations.length > 0 && <section className="settings-card staff-invites">
      <header><h2>已邀請、還沒設定密碼（{invitations.length}）</h2><p>對方設定好密碼後會自動變成員工，從這裡消失。沒收到信可以重寄，寄錯人可以取消。</p></header>
      <ul className="staff-invite-list">{invitations.map((inv) => <li key={inv.id}>
        <span><strong>{inv.displayName || inv.email}</strong><small>{inv.displayName ? `${inv.email}　` : ""}{staffRoleLabel(inv.role as AssignableStaffRole)}　邀請於 {dateLabel(inv.createdAt)}</small></span>
        <span className="row-actions">
          <button type="button" className="row-text-button" disabled={rowBusyId === inv.id || resentIds.has(inv.id)} onClick={() => resendInvite(inv)}><Mail size={14} />{rowBusyId === inv.id ? "寄送中…" : resentIds.has(inv.id) ? "已重寄" : "重寄邀請信"}</button>
          <button type="button" className="row-text-button danger-text-button" disabled={rowBusyId === inv.id} onClick={() => setConfirm({ kind: "cancel-invite", invitation: inv })}>取消邀請</button>
        </span>
        {rowError?.id === inv.id && <div className="error-box" role="alert">{rowError.message}</div>}
      </li>)}</ul>
    </section>}

    {!loaded && loading && !error ? <p className="panel-empty">載入員工中…</p> : loaded && <>
      <div className="notes-toolbar">
        <div className="stock-filter" role="group" aria-label="員工狀態">
          {([["active", "使用中"], ["inactive", "已停用"], ["all", "全部"]] as const).map(([id, label]) => <button key={id} type="button" className={status === id ? "active" : ""} aria-pressed={status === id} onClick={() => setStatus(id)}>{label}<span>{counts[id]}</span></button>)}
        </div>
        <div className="search-box"><Search size={18} /><input placeholder="搜尋姓名或 Email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜尋姓名或 Email" /></div>
      </div>
      {shown.length === 0 ? <div className="notes-empty compact"><p>{query.trim() ? "沒有符合的員工。" : status === "inactive" ? "沒有已停用的員工。" : "沒有員工。"}</p>{(query.trim() || status !== "all") && staff.length > 0 && <button type="button" className="secondary-button" onClick={() => { setQuery(""); setStatus("all"); }}>顯示全部</button>}</div>
        : <div className="table-card"><table className="staff-table"><thead><tr><th>姓名</th><th>角色</th><th>狀態</th>{canManage && <th>操作</th>}</tr></thead><tbody>{shown.map((member) => {
          const isEditing = editing?.id === member.id;
          const busy = rowBusyId === member.id;
          const isSelf = member.id === currentUserId;
          const blocked = adminChangeBlockedReason(member, staff, currentUserId);
          return <tr key={member.id} className={member.active ? "" : "staff-inactive"}>
            <td data-label="姓名">{isEditing
              ? <input className="staff-name-input" value={editing.name} maxLength={50} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="姓名" autoFocus />
              : <><strong>{member.displayName}</strong>{isSelf && <span className="staff-self">（你）</span>}<small>{member.email}</small>{hasPlaceholderName(member) && <small className="field-hint">還沒設定姓名，按「編輯」補上</small>}</>}</td>
            <td data-label="角色">{isEditing
              ? <><select value={editing.role} disabled={Boolean(blocked)} onChange={(e) => setEditing({ ...editing, role: e.target.value as AssignableStaffRole })} aria-label="角色">{ASSIGNABLE_STAFF_ROLES.map((r) => <option key={r} value={r}>{staffRoleLabel(r)}</option>)}</select>{blocked && <small className="field-hint">{blocked}</small>}</>
              : staffRoleLabel(member.role)}</td>
            <td data-label="狀態"><span className={member.active ? "pill" : "pill pill-red"}>{member.active ? "使用中" : "已停用"}</span></td>
            {canManage && <td data-label="操作">
              <div className="row-actions">
                {isEditing ? <>
                  <button type="button" className="row-text-button" disabled={busy} onClick={() => saveEdit(member)}>{busy ? "儲存中…" : "儲存"}</button>
                  <button type="button" className="row-text-button" disabled={busy} onClick={() => { setEditing(null); setRowError(null); }}>取消</button>
                </> : <>
                  <button type="button" className="row-text-button" disabled={busy} onClick={() => startEdit(member)}>編輯</button>
                  {member.active
                    ? <button type="button" className="row-text-button danger-text-button" disabled={busy || Boolean(blocked)} title={blocked ?? `停用 ${member.displayName}`} onClick={() => setConfirm({ kind: "deactivate", member })}>停用</button>
                    : <button type="button" className="row-text-button" disabled={busy} onClick={() => setActive(member, true)}>重新啟用</button>}
                </>}
              </div>
              {rowError?.id === member.id && <div className="error-box" role="alert">{rowError.message}</div>}
            </td>}
          </tr>;
        })}</tbody></table></div>}
      <p className="field-hint staff-footnote">使用中的管理員：{activeAdmins} 位。系統一定會留著至少一位，所以最後一位管理員不能被降級或停用。</p>
    </>}

    {confirm && <ConfirmModal
      title={confirm.kind === "deactivate" ? `停用 ${confirm.member.displayName}？` : confirm.kind === "role" ? `確定要改 ${confirm.member.displayName} 的角色？` : `取消對 ${confirm.invitation.email} 的邀請？`}
      subtitle={confirm.kind === "deactivate" ? "停用後可以隨時重新啟用" : confirm.kind === "role" ? "管理員權限很大，請確認" : "對方之後不能再用這封信成為員工"}
      body={confirm.kind === "deactivate"
        ? <p>停用後 {confirm.member.displayName} 無法再登入，也看不到任何資料；他以前寫的庫存異動、留言、採購紀錄都會保留。</p>
        : confirm.kind === "role"
          ? <p>{confirm.member.displayName} 的角色會從「{staffRoleLabel(confirm.member.role)}」改成「{staffRoleLabel(confirm.role)}」。{confirm.role === "admin" ? "管理員可以管理員工、刪除進貨單與交接留言、修改進貨單金額。" : "改完之後他就不能再管理員工與這些資料了。"}</p>
          : <p>邀請信裡的連結會失效。之後要再邀請，重新新增一次就可以。</p>}
      confirmLabel={confirm.kind === "deactivate" ? "確定停用" : confirm.kind === "role" ? "確定修改" : "確定取消邀請"}
      danger={confirm.kind !== "role" || confirm.member.role === "admin"}
      onClose={() => setConfirm(null)}
      onConfirm={async () => {
        const failure = confirm.kind === "deactivate" ? await setActive(confirm.member, false)
          : confirm.kind === "role" ? await applyEdit(confirm.member, confirm.name, confirm.role)
          : await cancelInvite(confirm.invitation);
        if (!failure) setConfirm(null);
        return failure;
      }}
    />}
  </>;
}

function ConfirmModal({ title, subtitle, body, confirmLabel, danger, onClose, onConfirm }: {
  title: string; subtitle: string; body: React.ReactNode; confirmLabel: string; danger: boolean;
  onClose: () => void; onConfirm: () => Promise<string | undefined>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const run = async () => {
    setSubmitting(true); submittingRef.current = true; setError("");
    const failure = await onConfirm();
    setSubmitting(false); submittingRef.current = false;
    if (failure) setError(failure);
  };
  // 開啟時把焦點放在「取消」（比較安全的選項），Tab 只在視窗內循環，按 Esc 可以關閉，關閉後焦點回到原本按下的那顆按鈕。
  useDialogFocus(dialogRef, onClose, () => submittingRef.current);
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}><div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <header><div><h2 id="confirm-title">{title}</h2><p>{subtitle}</p></div><button onClick={onClose} disabled={submitting} aria-label="關閉" title="關閉"><X /></button></header>
    <div className="modal-body">
      {body}
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" data-autofocus className="secondary-button" onClick={onClose} disabled={submitting}>取消</button><button className={danger ? "primary-button danger-button" : "primary-button"} onClick={run} disabled={submitting}>{submitting ? "處理中…" : confirmLabel}</button></div>
    </div>
  </div></div>;
}
