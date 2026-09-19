"use client";

import {
  AlertTriangle, Archive, BarChart3, Bell, Box, ChevronRight, ClipboardCheck, ClipboardList,
  Clock3, FileScan, LogOut, Menu, MessageSquareText, Pencil, Plus, Power, Search, Settings,
  ShoppingCart, Trash2, Users, X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { initialMovements, initialNotes, initialPurchases } from "@/lib/demo-data";
import { estimatedRemainingLabel, getLowStockReason, lowStockReasonLabel, periodFrequencyLabel } from "@/lib/inventory";
import { formatNumber, formatSignedNumber } from "@/lib/format";
import { generateId } from "@/lib/id";
import { staffRoleLabel } from "@/lib/staff";
import { PurchaseReportView } from "@/components/purchase-report-view";
import { ReceiptScanner } from "@/components/receipt-scanner";
import { SettingsView } from "@/components/settings-view";
import { StaffView } from "@/components/staff-view";
import { createClient } from "@/lib/supabase/client";
import type { AssignableStaffRole, HandoverNote, InventoryCategory, InventoryItem, InventoryItemInput, MovementType, PurchaseRequest, PurchaseStatus, ReceiptRecord, StockMovement, UsagePeriod } from "@/lib/types";

type View = "dashboard" | "inventory" | "purchases" | "movements" | "receipts" | "report" | "notes" | "staff" | "settings";
type Modal = "purchase" | "movement" | "item" | "note" | null;

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
);

function useSupabaseSession() {
  const [status, setStatus] = useState<"loading" | "authed" | "anon">(supabaseConfigured ? "loading" : "anon");
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) return;
    const supabase = createClient();
    let active = true;

    const timer = window.setTimeout(() => {
      supabase.auth.getUser().then(({ data }) => {
        if (!active) return;
        setEmail(data.user?.email ?? null);
        setUserId(data.user?.id ?? null);
        setStatus(data.user ? "authed" : "anon");
      });
    }, 0);

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
      setUserId(session?.user?.id ?? null);
      setStatus(session?.user ? "authed" : "anon");
    });

    return () => {
      active = false;
      window.clearTimeout(timer);
      listener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    if (!supabaseConfigured) return;
    const supabase = createClient();
    await supabase.auth.signOut();
  };

  return { configured: supabaseConfigured, status, email, userId, signOut };
}

function useStaffRole(session: ReturnType<typeof useSupabaseSession>) {
  const [role, setRole] = useState<AssignableStaffRole | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!session.configured || session.status !== "authed" || !session.userId) {
        if (active) setRole(null);
        return;
      }
      const supabase = createClient();
      supabase.from("staff_profiles").select("role,active").eq("id", session.userId as string).maybeSingle().then(({ data, error }) => {
        if (!active) return;
        // 讀不到自己的staff_profiles常見原因：這個帳號的active目前是false（is_active_staff()連自己的row都讀不到）。
        if (error) console.error("Load staff role failed", error);
        // viewer已移除且會被停用，這裡只承認active且角色仍為admin／purchaser／housekeeper的帳號。
        const validRole = data?.active && (data.role === "admin" || data.role === "purchaser" || data.role === "housekeeper")
          ? (data.role as AssignableStaffRole)
          : null;
        setRole(validRole);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [session.configured, session.status, session.userId]);

  return role;
}

function useCategories() {
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/categories");
      const data = await response.json() as { categories?: InventoryCategory[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取分類失敗");
      setCategories(data.categories || []);
      setDemo(Boolean(data.demo));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "讀取分類失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const mutate = async (request: () => Promise<Response>): Promise<string | void> => {
    try {
      const response = await request();
      const data = await response.json() as { error?: string };
      if (!response.ok) return data.error || "操作失敗，請稍後再試。";
      await refresh();
    } catch (reason) {
      return reason instanceof Error ? reason.message : "操作失敗，請稍後再試。";
    }
  };

  const addCategory = (name: string) => mutate(() => fetch("/api/categories", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  }));

  const renameCategory = (id: string, name: string) => mutate(() => fetch(`/api/categories/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  }));

  const toggleCategoryActive = (id: string, active: boolean) => mutate(() => fetch(`/api/categories/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }),
  }));

  const deleteCategory = (id: string) => mutate(() => fetch(`/api/categories/${id}`, { method: "DELETE" }));

  const reorderCategory = async (id: string, direction: "up" | "down"): Promise<string | void> => {
    const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = sorted.findIndex((c) => c.id === id);
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= sorted.length) return;
    const current = sorted[index];
    const target = sorted[swapIndex];
    return mutate(async () => {
      const [resA, resB] = await Promise.all([
        fetch(`/api/categories/${current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sortOrder: target.sortOrder }) }),
        fetch(`/api/categories/${target.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sortOrder: current.sortOrder }) }),
      ]);
      return resA.ok ? resB : resA;
    });
  };

  return { categories, loading, error, demo, addCategory, renameCategory, toggleCategoryActive, deleteCategory, reorderCategory };
}

function useInventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/inventory");
      const data = await response.json() as { items?: InventoryItem[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取庫存失敗");
      setItems(data.items || []);
      setDemo(Boolean(data.demo));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "讀取庫存失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const mutate = async (request: () => Promise<Response>): Promise<string | void> => {
    try {
      const response = await request();
      const data = await response.json() as { error?: string };
      if (!response.ok) return data.error || "操作失敗，請稍後再試。";
      await refresh();
    } catch (reason) {
      return reason instanceof Error ? reason.message : "操作失敗，請稍後再試。";
    }
  };

  const addItem = (payload: InventoryItemInput) => mutate(() => fetch("/api/inventory", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));

  const updateItem = (id: string, payload: Partial<InventoryItemInput>) => mutate(() => fetch(`/api/inventory/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));

  const setItemActive = (id: string, active: boolean) => mutate(() => fetch(`/api/inventory/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }),
  }));

  const deleteItem = (id: string) => mutate(() => fetch(`/api/inventory/${id}`, { method: "DELETE" }));

  // 盤點／修正庫存：透過record_stock_movement()交易函式寫入，quantity會是伺服器端的真實新值，
  // mutate內建的refresh()結束後items會拿到正確數量，不需要再手動調整。
  const countStock = (id: string, changeAmount: number, note?: string) => mutate(() => fetch(`/api/inventory/${id}/count`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changeAmount, note }),
  }));

  // 庫存異動（庫存增減）尚未接上Supabase，這裡只做畫面上的即時反映，重新整理後會回到伺服器端的實際數量。
  const adjustQuantityLocally = (name: string, delta: number) => {
    setItems((prev) => prev.map((item) => item.name === name ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item));
  };

  return { items, loading, error, demo, addItem, updateItem, setItemActive, deleteItem, countStock, adjustQuantityLocally, refresh };
}

const navItems: Array<{ id: View; label: string; icon: typeof Box }> = [
  { id: "dashboard", label: "總覽", icon: Box },
  { id: "inventory", label: "庫存管理", icon: Archive },
  { id: "purchases", label: "採購需求", icon: ShoppingCart },
  { id: "movements", label: "入庫與異動", icon: ClipboardList },
  { id: "receipts", label: "進貨單辨識", icon: FileScan },
  { id: "report", label: "進貨報表", icon: BarChart3 },
  { id: "notes", label: "交接留言", icon: MessageSquareText },
  { id: "staff", label: "員工管理", icon: Users },
];

const statusSteps: PurchaseStatus[] = ["待確認", "已訂購", "已到貨", "已入庫"];

function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(key);
      if (saved) {
        try { setValue(JSON.parse(saved) as T); } catch { /* ignore invalid demo data */ }
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [key]);
  useEffect(() => {
    if (hydrated) window.localStorage.setItem(key, JSON.stringify(value));
  }, [hydrated, key, value]);
  return [value, setValue] as const;
}

function Pill({ children, tone = "sage" }: { children: React.ReactNode; tone?: "sage" | "gold" | "red" | "blue" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function OperationsApp() {
  const session = useSupabaseSession();
  const role = useStaffRole(session);
  const [demoLoggedIn, setDemoLoggedIn] = useState(false);
  const [view, setView] = useState<View>("dashboard");
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<InventoryItem | null>(null);
  const [countingItem, setCountingItem] = useState<InventoryItem | null>(null);
  const [deletingNote, setDeletingNote] = useState<HandoverNote | null>(null);
  const [deletingMovement, setDeletingMovement] = useState<StockMovement | null>(null);
  const [query, setQuery] = useState("");
  const inventoryState = useInventory();
  const [purchases, setPurchases] = useStoredState("tea-purchases", initialPurchases);
  const [movements, setMovements] = useStoredState("tea-movements", initialMovements);
  const [notes, setNotes] = useStoredState("tea-notes", initialNotes);
  const categoryState = useCategories();
  const [receipts, setReceipts] = useStoredState<ReceiptRecord[]>("tea-receipts", []);
  const [retentionDays, setRetentionDays] = useStoredState("tea-receipt-retention", 90);

  const inventory = inventoryState.items;
  const activeInventory = useMemo(() => inventory.filter((item) => item.active), [inventory]);
  const canManageItems = role === "admin" || role === "purchaser";
  const canReactivateOrDeleteItems = role === "admin";
  const canCountStock = role === "admin" || role === "purchaser" || role === "housekeeper";
  const canViewPurchaseReport = role === "admin" || role === "purchaser";

  const activeCategoryNames = useMemo(() => categoryState.categories.filter((c) => c.active).map((c) => c.name), [categoryState.categories]);
  const filterCategoryNames = useMemo(() => Array.from(new Set([
    ...[...categoryState.categories].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => c.name),
    ...inventory.map((item) => item.category),
  ])), [categoryState.categories, inventory]);
  const itemFormCategoryOptions = useMemo(() => {
    if (!editingItem || activeCategoryNames.includes(editingItem.category)) return activeCategoryNames;
    return [editingItem.category, ...activeCategoryNames];
  }, [activeCategoryNames, editingItem]);

  const lowStock = useMemo(() => activeInventory.filter((item) => getLowStockReason(item) !== null), [activeInventory]);
  const expiring = useMemo(() => activeInventory.filter((item) => item.expiryDate).slice(0, 4), [activeInventory]);
  const pending = purchases.filter((request) => !["已入庫", "暫緩"].includes(request.status));

  const openPurchaseModal = (initialItem?: string) => {
    if (!activeInventory.length) { alert("目前沒有可採購的庫存品項，請先新增品項。"); return; }
    if (initialItem) setQuery(initialItem);
    setModal("purchase");
  };
  const openMovementModal = () => {
    if (!activeInventory.length) { alert("目前沒有可登記異動的庫存品項，請先新增品項。"); return; }
    setModal("movement");
  };

  const isLoggedIn = session.configured ? session.status === "authed" : demoLoggedIn;
  if (session.configured && session.status === "loading") {
    return <main className="login-page"><div className="login-panel"><div className="login-card"><p>載入登入狀態中…</p></div></div></main>;
  }
  if (!isLoggedIn) return <LoginScreen supabaseConfigured={session.configured} onDemoLogin={() => setDemoLoggedIn(true)} />;

  const openView = (next: View) => { setView(next); setMobileNav(false); };
  const handleLogout = () => { if (session.configured) session.signOut(); else setDemoLoggedIn(false); };
  const displayName = session.configured ? (session.email || "員工") : "管理員 Alan（示範）";
  const avatarLetter = session.configured ? (session.email?.[0]?.toUpperCase() || "?") : "A";

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">茶</span>
          <div><strong>茶香花園民宿</strong><small>內部採購與庫存</small></div>
          <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="關閉選單"><X size={20} /></button>
        </div>
        <nav>
          {navItems.filter((item) => item.id !== "report" || canViewPurchaseReport).map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => openView(item.id)}><Icon size={20} />{item.label}</button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => openView("settings")}><Settings size={19} />系統設定</button>
          <button onClick={handleLogout}><LogOut size={19} />登出</button>
          <p>{session.configured ? "已透過Supabase Auth登入 · 分類與庫存品項所有登入人員共用" : "示範模式 · 資料保存在此瀏覽器"}</p>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(true)} aria-label="開啟選單"><Menu /></button>
          <div className="page-title"><span>茶香花園民宿</span><strong>{view === "settings" ? "系統設定" : navItems.find((n) => n.id === view)?.label}</strong></div>
          <div className="top-actions"><button className="icon-button"><Bell size={19} /><i>{lowStock.length}</i></button><div className="user-badge">{avatarLetter}</div><div className="user-copy"><strong>{displayName}</strong><small>{session.configured ? (role ? staffRoleLabel(role) : "尚未指派角色") : "管理員（示範）"}</small></div></div>
        </header>

        <section className="content">
          {view === "dashboard" && <Dashboard lowStock={lowStock} pending={pending} expiring={expiring} notes={notes} onView={openView} onPurchase={() => openPurchaseModal()} />}
          {view === "inventory" && <InventoryView
            items={inventory}
            loading={inventoryState.loading}
            error={inventoryState.error}
            demo={inventoryState.demo}
            categories={filterCategoryNames}
            query={query}
            setQuery={setQuery}
            canManage={canManageItems}
            canReactivateOrDelete={canReactivateOrDeleteItems}
            canCount={canCountStock}
            onAddItem={() => { setEditingItem(null); setModal("item"); }}
            onEditItem={(item) => { setEditingItem(item); setModal("item"); }}
            onToggleActive={(item) => inventoryState.setItemActive(item.id, !item.active)}
            onDeleteItem={(item) => setDeletingItem(item)}
            onCountItem={(item) => setCountingItem(item)}
            onMovement={openMovementModal}
            onPurchase={openPurchaseModal}
          />}
          {view === "purchases" && <PurchasesView requests={purchases} setRequests={setPurchases} onNew={() => openPurchaseModal()} />}
          {view === "movements" && <MovementsView movements={movements} canManage={role === "admin"} onNew={openMovementModal} onDelete={(movement) => setDeletingMovement(movement)} />}
          {view === "receipts" && <ReceiptScanner inventory={activeInventory} categories={activeCategoryNames} receipts={receipts} retentionDays={retentionDays} onConfirm={async (record) => {
            // 新品項建立、庫存數量與異動紀錄都已經在Supabase交易（RPC）內原子性完成，這裡只需要重新整理庫存，
            // 並把「非忽略」的品項加進本地顯示用的異動紀錄清單。
            await inventoryState.refresh();
            const nextMovements = [...movements];
            for (const line of record.lines) {
              if (line.resolution === "ignore") continue;
              nextMovements.unshift({ id: generateId(), itemName: line.itemName, type: "採購入庫", change: line.quantity, unit: line.unit, operator: displayName, createdAt: new Date().toLocaleString("zh-TW", { hour12: false }), note: `進貨單：${record.fileName}${record.invoiceNumber ? `／${record.invoiceNumber}` : ""}` });
            }
            setMovements(nextMovements);
            setReceipts([record, ...receipts]);
          }} />}
          {view === "report" && <PurchaseReportView canView={canViewPurchaseReport} canManage={role === "admin"} />}
          {view === "notes" && <NotesView notes={notes} canManage={role === "admin"} onNew={() => setModal("note")} onDelete={(note) => setDeletingNote(note)} />}
          {view === "staff" && <StaffView canManage={role === "admin"} currentUserId={session.userId} />}
          {view === "settings" && <SettingsView
            categories={categoryState.categories}
            categoriesLoading={categoryState.loading}
            categoriesError={categoryState.error}
            categoriesDemo={categoryState.demo}
            retentionDays={retentionDays}
            onAddCategory={categoryState.addCategory}
            onRenameCategory={categoryState.renameCategory}
            onReorderCategory={categoryState.reorderCategory}
            onToggleCategoryActive={categoryState.toggleCategoryActive}
            onDeleteCategory={categoryState.deleteCategory}
            onRetentionChange={setRetentionDays}
          />}
        </section>
      </main>

      {modal === "purchase" && <PurchaseModal inventory={activeInventory} initialItem={query} onClose={() => setModal(null)} onSave={(request) => { setPurchases([request, ...purchases]); setModal(null); setQuery(""); }} />}
      {modal === "movement" && <MovementModal inventory={activeInventory} onClose={() => setModal(null)} onSave={(movement) => {
        setMovements([movement, ...movements]);
        inventoryState.adjustQuantityLocally(movement.itemName, movement.change);
        setModal(null);
      }} />}
      {modal === "item" && <ItemModal
        categories={itemFormCategoryOptions}
        item={editingItem}
        onClose={() => { setModal(null); setEditingItem(null); }}
        onSave={async (payload) => {
          const error = editingItem
            ? await inventoryState.updateItem(editingItem.id, payload)
            : await inventoryState.addItem(payload);
          if (!error) { setModal(null); setEditingItem(null); }
          return error;
        }}
      />}
      {modal === "note" && <NoteModal onClose={() => setModal(null)} onSave={(note) => { setNotes([note, ...notes]); setModal(null); }} />}
      {deletingItem && <ConfirmDeleteItemModal
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        onConfirm={() => inventoryState.deleteItem(deletingItem.id)}
      />}
      {countingItem && <StockCountModal
        item={countingItem}
        onClose={() => setCountingItem(null)}
        onConfirm={async (changeAmount, note) => {
          const error = await inventoryState.countStock(countingItem.id, changeAmount, note);
          if (!error) {
            setMovements([{ id: generateId(), itemName: countingItem.name, type: "盤點調整", change: changeAmount, unit: countingItem.unit, operator: displayName, createdAt: new Date().toLocaleString("zh-TW", { hour12: false }), note: note || "盤點修正" }, ...movements]);
          }
          return error;
        }}
      />}
      {deletingNote && <ConfirmDeleteNoteModal
        note={deletingNote}
        onClose={() => setDeletingNote(null)}
        onConfirm={() => setNotes(notes.filter((n) => n.id !== deletingNote.id))}
      />}
      {deletingMovement && <ConfirmDeleteMovementModal
        movement={deletingMovement}
        onClose={() => setDeletingMovement(null)}
        onConfirm={() => setMovements(movements.filter((m) => m.id !== deletingMovement.id))}
      />}
    </div>
  );
}

function LoginScreen({ supabaseConfigured, onDemoLogin }: { supabaseConfigured: boolean; onDemoLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const redirectError = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("auth_error") === "1";
  }, []);

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSending(true);
    setError("");
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: value,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (authError) throw authError;
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "寄送登入連結失敗，請稍後再試。");
    } finally {
      setSending(false);
    }
  };

  return <main className="login-page">
    <div className="login-art"><div className="mountains" /><div className="login-message"><span>ALISHAN · TEA GARDEN</span><h1>讓每一次補貨，<br />都比缺貨早一步。</h1><p>民宿備品、早餐、晚餐食材與交接事項，一個地方清楚掌握。</p></div></div>
    <div className="login-panel"><div className="login-card">
      <div className="login-logo">茶</div><h2>內部管理系統</h2><p>僅限茶香花園民宿工作人員使用</p>
      {supabaseConfigured ? (sent ? <div className="setting-note">已寄出登入連結到 {email}，請至信箱點擊連結完成登入。</div> : <form onSubmit={sendMagicLink}>
        <label>員工Email<input required value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="you@teagarden.local" /></label>
        {(error || redirectError) && <div className="error-box">{error || "登入連結已失效或不正確，請重新索取。"}</div>}
        <button className="primary-button" disabled={sending}>{sending ? "寄送中…" : "寄送登入連結"}<ChevronRight size={18} /></button>
        <div className="login-note">系統會寄送一次性登入連結到你的Email，僅限已加入員工名單（staff_profiles）的帳號可登入。</div>
      </form>) : <>
        <label>員工Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" /></label>
        <button className="primary-button" onClick={onDemoLogin}>使用示範模式登入<ChevronRight size={18} /></button>
        <div className="login-note">尚未設定Supabase，目前為離線示範模式</div>
      </>}
    </div></div>
  </main>;
}

function Dashboard({ lowStock, pending, expiring, notes, onView, onPurchase }: { lowStock: InventoryItem[]; pending: PurchaseRequest[]; expiring: InventoryItem[]; notes: HandoverNote[]; onView: (v: View) => void; onPurchase: () => void }) {
  return <>
    <div className="hero-row"><div><p>2026年9月18日 · 星期五</p><h1>早安，今天有 <em>{lowStock.length}</em> 項庫存需要注意</h1></div><button className="primary-button" onClick={onPurchase}><Plus size={19} />新增採購需求</button></div>
    <div className="stat-grid">
      <Stat icon={AlertTriangle} label="低庫存" value={lowStock.length} tone="red" onClick={() => onView("inventory")} />
      <Stat icon={ShoppingCart} label="待處理採購" value={pending.length} tone="sage" onClick={() => onView("purchases")} />
      <Stat icon={Clock3} label="即將過期" value={expiring.length} tone="gold" onClick={() => onView("inventory")} />
      <Stat icon={MessageSquareText} label="交接留言" value={notes.length} tone="blue" onClick={() => onView("notes")} />
    </div>
    <div className="dashboard-grid">
      <Panel title="低庫存品項" icon={Box} action="查看全部" onAction={() => onView("inventory")}>
        <div className="compact-list">{lowStock.slice(0, 5).map((item) => <div key={item.id}><span className="item-avatar">{item.name.slice(0, 1)}</span><div><strong>{item.name}</strong><small>{item.location}</small></div><b>{formatNumber(item.quantity)}{item.unit}</b><span>安全 {formatNumber(item.safetyStock)}{item.unit}</span></div>)}</div>
      </Panel>
      <Panel title="待處理採購" icon={ShoppingCart} action="管理採購" onAction={() => onView("purchases")}>
        <div className="compact-list">{pending.slice(0, 5).map((r) => <div key={r.id}><span className="item-avatar">購</span><div><strong>{r.itemName}</strong><small>{r.requester} · {r.requestedAt.slice(5, 10)}</small></div><b>{r.quantity}{r.unit}</b><Status status={r.status} /></div>)}</div>
      </Panel>
      <Panel title="即將過期食材" icon={Clock3} action="查看庫存" onAction={() => onView("inventory")}>
        <div className="expiry-list">{expiring.map((item) => <div key={item.id}><div><strong>{item.name}</strong><small>目前 {formatNumber(item.quantity)}{item.unit}</small></div><Pill tone="gold">{item.expiryDate} 到期</Pill></div>)}</div>
      </Panel>
      <Panel title="最新交接留言" icon={MessageSquareText} action="查看留言" onAction={() => onView("notes")}>
        <div className="note-list">{notes.slice(0, 3).map((note) => <div key={note.id}><span className={note.important ? "note-dot important" : "note-dot"} /><div><strong>{note.content}</strong><small>{note.author} · {note.createdAt}</small></div></div>)}</div>
      </Panel>
    </div>
  </>;
}

function Stat({ icon: Icon, label, value, tone, onClick }: { icon: typeof Box; label: string; value: number; tone: string; onClick: () => void }) {
  return <button className={`stat-card stat-${tone}`} onClick={onClick}><span><Icon size={24} /></span><div><small>{label}</small><strong>{value}</strong></div><ChevronRight size={20} /></button>;
}

function Panel({ title, icon: Icon, action, onAction, children }: { title: string; icon: typeof Box; action: string; onAction: () => void; children: React.ReactNode }) {
  return <article className="panel"><header><h2><Icon size={21} />{title}</h2><button onClick={onAction}>{action}<ChevronRight size={16} /></button></header>{children}</article>;
}

function PageHeader({ title, subtitle, button, onClick }: { title: string; subtitle: string; button?: string; onClick?: () => void }) {
  return <div className="section-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{button && <button className="primary-button" onClick={onClick}><Plus size={18} />{button}</button>}</div>;
}

function InventoryView({ items, loading, error, demo, categories, query, setQuery, canManage, canReactivateOrDelete, canCount, onAddItem, onEditItem, onToggleActive, onDeleteItem, onCountItem, onMovement, onPurchase }: {
  items: InventoryItem[];
  loading: boolean;
  error: string;
  demo: boolean;
  categories: string[];
  query: string;
  setQuery: (q: string) => void;
  canManage: boolean;
  canReactivateOrDelete: boolean;
  canCount: boolean;
  onAddItem: () => void;
  onEditItem: (item: InventoryItem) => void;
  onToggleActive: (item: InventoryItem) => void;
  onDeleteItem: (item: InventoryItem) => void;
  onCountItem: (item: InventoryItem) => void;
  onMovement: () => void;
  onPurchase: (name: string) => void;
}) {
  const [category, setCategory] = useState("全部");
  const [showInactive, setShowInactive] = useState(false);
  const visible = showInactive ? items : items.filter((item) => item.active);
  const filtered = visible.filter((item) => (category === "全部" || item.category === category) && item.name.includes(query));
  return <><div className="section-header"><div><h1>庫存管理</h1><p>掌握各區備品與食材數量，低於安全庫存或預估用量不足時立即提醒。</p></div><div className="header-actions"><button className="secondary-button" onClick={onMovement}>新增庫存異動</button><button className="primary-button" onClick={onAddItem} disabled={!canManage}><Plus size={18} />新增品項</button></div></div>
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，目前僅顯示唯讀示範庫存，無法新增／編輯／停用／刪除／盤點。</span></div>}
    {error && <div className="error-box">{error}</div>}
    <div className="toolbar"><div className="search-box"><Search size={18} /><input placeholder="搜尋品項" value={query} onChange={(e) => setQuery(e.target.value)} /></div><select value={category} onChange={(e) => setCategory(e.target.value)}><option>全部</option>{categories.map((name) => <option key={name}>{name}</option>)}</select><label className="check-label inline-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />顯示停用品項</label></div>
    {loading ? <p>載入庫存中…</p> : <div className="table-card"><table><thead><tr><th>品項</th><th>分類／位置</th><th>目前庫存</th><th>安全庫存</th><th>預估使用</th><th>有效期限</th><th>狀態</th><th>低庫存原因</th><th>操作</th></tr></thead><tbody>{filtered.map((item) => {
      const reason = getLowStockReason(item);
      const remaining = estimatedRemainingLabel(item);
      return <tr key={item.id} className={item.active ? "" : "inventory-row-inactive"}>
        <td><strong>{item.name}</strong><small>{item.supplier || "未設定供應商"}</small></td>
        <td>{item.category}<small>{item.location}</small></td>
        <td><b className={reason ? "danger-text" : ""}>{formatNumber(item.quantity)} {item.unit}</b></td>
        <td>{formatNumber(item.safetyStock)} {item.unit}</td>
        <td>{item.usageForecastEnabled && item.estimatedUsage && item.usagePeriod ? <><strong>{periodFrequencyLabel(item.usagePeriod)}{formatNumber(item.estimatedUsage)}{item.unit}</strong><small>{remaining}</small></> : <small>未啟用</small>}</td>
        <td>{item.expiryDate || "—"}</td>
        <td>{!item.active ? <Pill tone="red">已停用</Pill> : reason ? <Pill tone="red">低庫存</Pill> : <Pill>充足</Pill>}</td>
        <td>{reason ? <small className="danger-text">{lowStockReasonLabel(reason)}</small> : "—"}</td>
        <td><div className="row-actions">{item.active && <button className="text-button" onClick={() => onPurchase(item.name)}>提出採購</button>}<button aria-label={`盤點${item.name}`} disabled={!canCount} onClick={() => onCountItem(item)}><ClipboardCheck size={15} /></button><button aria-label={`編輯${item.name}`} disabled={!canManage} onClick={() => onEditItem(item)}><Pencil size={15} /></button><button aria-label={item.active ? `停用${item.name}` : `啟用${item.name}`} disabled={item.active ? !canManage : !canReactivateOrDelete} onClick={() => onToggleActive(item)}><Power size={15} /></button><button className="danger" aria-label={`刪除${item.name}`} disabled={!canReactivateOrDelete} onClick={() => onDeleteItem(item)}><Trash2 size={15} /></button></div></td>
      </tr>;
    })}</tbody></table></div>}
  </>;
}

function PurchasesView({ requests, setRequests, onNew }: { requests: PurchaseRequest[]; setRequests: (r: PurchaseRequest[]) => void; onNew: () => void }) {
  const advance = (request: PurchaseRequest) => { const index = statusSteps.indexOf(request.status); if (index < 0 || index >= statusSteps.length - 1) return; setRequests(requests.map((r) => r.id === request.id ? { ...r, status: statusSteps[index + 1] } : r)); };
  return <><PageHeader title="採購需求" subtitle="從提出、訂購到入庫，清楚追蹤每一項採購。" button="新增採購需求" onClick={onNew} />
    <div className="purchase-board">{statusSteps.slice(0, -1).map((status) => <section key={status} className="purchase-column"><header><span>{status}</span><b>{requests.filter((r) => r.status === status).length}</b></header>{requests.filter((r) => r.status === status).map((r) => <article key={r.id} className="purchase-card"><div><strong>{r.itemName}</strong>{r.priority === "急件" && <Pill tone="red">急件</Pill>}</div><h3>{r.quantity} {r.unit}</h3><p>{r.note || "沒有補充說明"}</p><small>{r.requester} · {r.requestedAt}</small><button onClick={() => advance(r)}>{status === "已到貨" ? "確認入庫" : "前往下一階段"}<ChevronRight size={15} /></button></article>)}</section>)}</div>
  </>;
}

function MovementsView({ movements, canManage, onNew, onDelete }: { movements: StockMovement[]; canManage: boolean; onNew: () => void; onDelete: (movement: StockMovement) => void }) {
  return <><PageHeader title="入庫與異動紀錄" subtitle="所有增加、領用、報廢與盤點調整都保留紀錄。" button="新增庫存異動" onClick={onNew} />
    <div className="table-card"><table><thead><tr><th>時間</th><th>品項</th><th>異動類型</th><th>數量</th><th>操作人</th><th>備註</th>{canManage && <th>操作</th>}</tr></thead><tbody>{movements.map((m) => <tr key={m.id}><td>{m.createdAt}</td><td><strong>{m.itemName}</strong></td><td>{m.type}</td><td><b className={m.change > 0 ? "positive-text" : "danger-text"}>{formatSignedNumber(m.change)} {m.unit}</b></td><td>{m.operator}</td><td>{m.note || "—"}</td>{canManage && <td><div className="row-actions"><button className="danger" aria-label="刪除這筆異動紀錄" onClick={() => onDelete(m)}><Trash2 size={15} /></button></div></td>}</tr>)}</tbody></table></div>
  </>;
}

function NotesView({ notes, canManage, onNew, onDelete }: { notes: HandoverNote[]; canManage: boolean; onNew: () => void; onDelete: (note: HandoverNote) => void }) {
  return <><PageHeader title="交接留言" subtitle="將客人需求、房務、設備與餐飲事項留在對的位置。" button="新增交接留言" onClick={onNew} /><div className="notes-page">{notes.map((note) => <article key={note.id}><header><Pill tone={note.important ? "red" : "sage"}>{note.category}</Pill>{note.important && <span className="important-label">重要</span>}{canManage && <button className="note-delete" aria-label="刪除留言" onClick={() => onDelete(note)}><Trash2 size={15} /></button>}</header><p>{note.content}</p><footer>{note.author}<span>{note.createdAt}</span></footer></article>)}</div></>;
}


function Status({ status }: { status: PurchaseStatus }) {
  const tone = status === "待確認" ? "red" : status === "已訂購" ? "blue" : "gold";
  return <Pill tone={tone}>{status}</Pill>;
}

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal"><header><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose}><X /></button></header>{children}</div></div>;
}

function PurchaseModal({ inventory, initialItem, onClose, onSave }: { inventory: InventoryItem[]; initialItem: string; onClose: () => void; onSave: (p: PurchaseRequest) => void }) {
  const first = inventory.find((i) => i.name === initialItem) || inventory[0];
  const [itemName, setItemName] = useState(first.name); const current = inventory.find((i) => i.name === itemName) || first;
  const [quantity, setQuantity] = useState(current.suggestedPurchase); const [priority, setPriority] = useState<"一般" | "急件">("一般"); const [note, setNote] = useState("");
  return <ModalShell title="新增採購需求" subtitle="提出後將進入待確認清單" onClose={onClose}><form onSubmit={(e) => { e.preventDefault(); onSave({ id: generateId(), itemName, quantity, unit: current.unit, priority, status: "待確認", requester: "Alan", requestedAt: new Date().toLocaleString("zh-TW", { hour12: false }), note }); }}><label>品項<select value={itemName} onChange={(e) => { setItemName(e.target.value); const next = inventory.find((i) => i.name === e.target.value); if (next) setQuantity(next.suggestedPurchase); }}>{inventory.map((i) => <option key={i.id}>{i.name}</option>)}</select></label><div className="form-grid"><label>採購數量<input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></label><label>急迫程度<select value={priority} onChange={(e) => setPriority(e.target.value as "一般" | "急件")}><option>一般</option><option>急件</option></select></label></div><div className="stock-hint">目前庫存：{formatNumber(current.quantity)}{current.unit}　安全庫存：{formatNumber(current.safetyStock)}{current.unit}</div><label>原因或備註<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：明天有12位早餐客人" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">送出採購需求</button></div></form></ModalShell>;
}

function MovementModal({ inventory, onClose, onSave }: { inventory: InventoryItem[]; onClose: () => void; onSave: (m: StockMovement) => void }) {
  const [itemName, setItemName] = useState(inventory[0].name); const item = inventory.find((i) => i.name === itemName) || inventory[0]; const [type, setType] = useState<MovementType>("採購入庫"); const [amount, setAmount] = useState(1); const [note, setNote] = useState("");
  const positive = type === "採購入庫" || (type === "盤點調整" && amount > 0);
  return <ModalShell title="新增庫存異動" subtitle="異動會保留操作紀錄，不直接覆蓋原數量" onClose={onClose}><form onSubmit={(e) => { e.preventDefault(); const change = positive ? Math.abs(amount) : -Math.abs(amount); onSave({ id: generateId(), itemName, type, change, unit: item.unit, operator: "Alan", createdAt: new Date().toLocaleString("zh-TW", { hour12: false }), note }); }}><label>品項<select value={itemName} onChange={(e) => setItemName(e.target.value)}>{inventory.map((i) => <option key={i.id}>{i.name}</option>)}</select></label><div className="form-grid"><label>異動類型<select value={type} onChange={(e) => setType(e.target.value as MovementType)}><option>採購入庫</option><option>日常領用</option><option>客房補充</option><option>食材使用</option><option>損壞</option><option>過期報廢</option><option>盤點調整</option></select></label><label>數量（{item.unit}）<input type="number" min="1" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label></div><div className="stock-hint">異動前庫存：{formatNumber(item.quantity)}{item.unit}</div><label>備註<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="填寫用途或調整原因" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">儲存異動</button></div></form></ModalShell>;
}

function ItemModal({ categories, item, onClose, onSave }: {
  categories: string[];
  item: InventoryItem | null;
  onClose: () => void;
  onSave: (payload: InventoryItemInput) => Promise<string | void>;
}) {
  const isEdit = Boolean(item);
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? categories[0] ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "個");
  const [safetyStock, setSafetyStock] = useState(item?.safetyStock ?? 0);
  const [suggestedPurchase, setSuggestedPurchase] = useState(item?.suggestedPurchase ?? 1);
  const [location, setLocation] = useState(item?.location ?? "");
  const [supplier, setSupplier] = useState(item?.supplier ?? "");
  const [expiryDate, setExpiryDate] = useState(item?.expiryDate ?? "");
  const [usageForecastEnabled, setUsageForecastEnabled] = useState(item?.usageForecastEnabled ?? false);
  const [estimatedUsage, setEstimatedUsage] = useState(item?.estimatedUsage ?? 1);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>(item?.usagePeriod ?? "daily");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !category) return;
    if (usageForecastEnabled && !(estimatedUsage > 0)) { setError("預估使用量必須大於0。"); return; }
    setSubmitting(true);
    setError("");
    const saveError = await onSave({
      name: name.trim(),
      category,
      unit: unit.trim() || "個",
      safetyStock,
      suggestedPurchase,
      location: location.trim() || "待設定",
      supplier: supplier.trim() || undefined,
      expiryDate: expiryDate || undefined,
      usageForecastEnabled,
      estimatedUsage: usageForecastEnabled ? estimatedUsage : undefined,
      usagePeriod: usageForecastEnabled ? usagePeriod : undefined,
    });
    setSubmitting(false);
    if (saveError) setError(saveError);
  };

  return <ModalShell title={isEdit ? "編輯庫存品項" : "新增庫存品項"} subtitle={isEdit ? "更新品項的基本資料" : "建立後即可採購、入庫與設定低庫存提醒"} onClose={onClose}><form onSubmit={submit}>
    <label>品項名稱<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：客房瓶裝水" /></label>
    {categories.length === 0 && <div className="warning-box"><span>• 目前沒有啟用中的分類，請先到「系統設定」新增或啟用分類。</span></div>}
    <div className="form-grid"><label>分類<select required disabled={categories.length === 0} value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((name) => <option key={name}>{name}</option>)}</select></label><label>計算單位<input required value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="包、瓶、公斤" /></label></div>
    <div className="form-grid"><label>安全庫存<input type="number" min="0" step="0.01" value={safetyStock} onChange={(e) => setSafetyStock(Number(e.target.value))} /></label><label>建議採購量<input type="number" min="0" step="0.01" value={suggestedPurchase} onChange={(e) => setSuggestedPurchase(Number(e.target.value))} /></label></div>
    <div className="form-grid"><label>存放位置<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例如：一樓備品室" /></label><label>供應商<input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="可稍後設定" /></label></div>
    <label>保存期限（可不填）<input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></label>
    <label className="check-label"><input type="checkbox" checked={usageForecastEnabled} onChange={(e) => setUsageForecastEnabled(e.target.checked)} />啟用預估使用量</label>
    {usageForecastEnabled && <div className="form-grid"><label>預估使用量（{unit || "單位"}）<input required type="number" min="0.01" step="0.01" value={estimatedUsage} onChange={(e) => setEstimatedUsage(Number(e.target.value))} /></label><label>使用週期<select value={usagePeriod} onChange={(e) => setUsagePeriod(e.target.value as UsagePeriod)}><option value="daily">每日</option><option value="weekly">每週</option><option value="monthly">每月</option></select></label></div>}
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={categories.length === 0 || submitting}>{submitting ? "儲存中…" : isEdit ? "儲存變更" : "建立品項"}</button></div>
  </form></ModalShell>;
}

function ConfirmDeleteItemModal({ item, onClose, onConfirm }: { item: InventoryItem; onClose: () => void; onConfirm: () => Promise<string | void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setSubmitting(true);
    setError("");
    const deleteError = await onConfirm();
    setSubmitting(false);
    if (deleteError) setError(deleteError); else onClose();
  };

  return <ModalShell title="刪除庫存品項" subtitle="此操作無法復原" onClose={onClose}>
    <p>確定要永久刪除「<strong>{item.name}</strong>」嗎？</p>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" onClick={confirm} disabled={submitting}>{submitting ? "刪除中…" : "確定刪除"}</button></div>
  </ModalShell>;
}

function ConfirmDeleteNoteModal({ note, onClose, onConfirm }: { note: HandoverNote; onClose: () => void; onConfirm: () => void }) {
  return <ModalShell title="刪除交接留言" subtitle="此操作無法復原" onClose={onClose}>
    <p>確定要刪除這則留言嗎？</p>
    <div className="note-delete-preview"><Pill tone={note.important ? "red" : "sage"}>{note.category}</Pill><p>{note.content}</p><small>{note.author} · {note.createdAt}</small></div>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" onClick={() => { onConfirm(); onClose(); }}>確定刪除</button></div>
  </ModalShell>;
}

function ConfirmDeleteMovementModal({ movement, onClose, onConfirm }: { movement: StockMovement; onClose: () => void; onConfirm: () => void }) {
  return <ModalShell title="刪除異動紀錄" subtitle="此操作無法復原" onClose={onClose}>
    <p>確定要刪除這筆紀錄嗎？</p>
    <div className="note-delete-preview"><strong>{movement.itemName}</strong><p>{movement.type} · {formatSignedNumber(movement.change)} {movement.unit}</p><small>{movement.operator} · {movement.createdAt}</small></div>
    <div className="warning-box"><span>• 這只會從這份紀錄清單移除，不會反向調整庫存數量；如果數量本身也需要修正，請到「庫存管理」用「盤點／修正庫存」處理。</span></div>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" onClick={() => { onConfirm(); onClose(); }}>確定刪除</button></div>
  </ModalShell>;
}

function StockCountModal({ item, onClose, onConfirm }: { item: InventoryItem; onClose: () => void; onConfirm: (changeAmount: number, note?: string) => Promise<string | void> }) {
  const [actual, setActual] = useState(item.quantity);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const diff = Math.round((actual - item.quantity) * 100) / 100;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (diff === 0) return;
    setSubmitting(true);
    setError("");
    const saveError = await onConfirm(diff, note.trim() || undefined);
    setSubmitting(false);
    if (saveError) setError(saveError); else onClose();
  };

  return <ModalShell title="盤點／修正庫存" subtitle={`品項：${item.name}`} onClose={onClose}><form onSubmit={submit}>
    <div className="stock-hint">系統目前數量：{formatNumber(item.quantity)} {item.unit}</div>
    <label>實際盤點數量（{item.unit}）<input type="number" step="0.01" value={actual} onChange={(e) => setActual(Number(e.target.value))} /></label>
    {diff === 0 ? <div className="setting-note">庫存數量一致，不需要建立異動紀錄。</div> : <div className={`stock-hint ${diff > 0 ? "positive-text" : "danger-text"}`}>差異數量：{formatSignedNumber(diff)} {item.unit}</div>}
    <label>修正原因或備註（可不填）<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：季度盤點、破損報廢" /></label>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={diff === 0 || submitting}>{submitting ? "儲存中…" : "確認修正庫存"}</button></div>
  </form></ModalShell>;
}

function NoteModal({ onClose, onSave }: { onClose: () => void; onSave: (n: HandoverNote) => void }) {
  const [category, setCategory] = useState<HandoverNote["category"]>("房務問題"); const [content, setContent] = useState(""); const [important, setImportant] = useState(false);
  return <ModalShell title="新增交接留言" subtitle="重要事項請開啟標記，讓下一班人員優先看到" onClose={onClose}><form onSubmit={(e) => { e.preventDefault(); if (!content.trim()) return; onSave({ id: generateId(), category, content, important, author: "Alan", createdAt: new Date().toLocaleString("zh-TW", { hour12: false }) }); }}><label>分類<select value={category} onChange={(e) => setCategory(e.target.value as HandoverNote["category"])}><option>客人需求</option><option>房務問題</option><option>設備維修</option><option>餐飲</option><option>重要公告</option></select></label><label>留言內容<textarea required value={content} onChange={(e) => setContent(e.target.value)} placeholder="請清楚寫下需要接續處理的事情" /></label><label className="check-label"><input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />標記為重要事項</label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">新增留言</button></div></form></ModalShell>;
}
