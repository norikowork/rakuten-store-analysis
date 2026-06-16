import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import SupplementTracker from "./SupplementTracker";
// @ts-ignore
// lz-stringはCommonJS形式なので動的インポートで対応
async function getLZString() {
  const module = await import("lz-string");
  return module.default || module;
}

async function compressToBase64(str: string): Promise<string> {
  const lz = await getLZString();
  return lz.compressToBase64(str);
}

async function decompressFromBase64(str: string): Promise<string | null> {
  const lz = await getLZString();
  return lz.decompressFromBase64(str);
}

// 認証SDKの動的インポート
let auth: any = null;

// 圧縮・解凍の共通関数（後方互換）
async function saveStateToDB(key: string, value: string): Promise<{ ok: boolean; status: number }> {
  try {
    const compressed = compressToBase64(value);
    
    // 認証ヘッダーを追加
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    
    if (auth) {
      try {
        const user = await auth.getUser();
        if (user) {
          headers["x-user-uuid"] = user.uuid || "";
        }
      } catch (e) {
        console.warn("ユーザー情報取得エラー（無視）:", e);
      }
    }
    
    const res = await fetch("/api/state", {
      method: "POST",
      headers,
      body: JSON.stringify({ key, value: compressed })
    });
    return { ok: res.ok, status: res.status };
  } catch (e: any) {
    console.error("DB保存例外:", e);
    return { ok: false, status: 0 };
  }
}

async function loadStateFromDB(key: string): Promise<{ value: string | null } | null> {
  try {
    const headers: Record<string, string> = {};
    
    if (auth) {
      try {
        const user = await auth.getUser();
        if (user) {
          headers["x-user-uuid"] = user.uuid || "";
        }
      } catch (e) {
        console.warn("ユーザー情報取得エラー（無視）:", e);
      }
    }
    
    const res = await fetch(`/api/state?key=${key}`, { headers });
    if (!res.ok) {
      console.warn("DB取得失敗:", res.status);
      return null;
    }
    const data = await res.json();
    if (!data.value) return { value: null };
    
    // まず非圧縮としてJSON.parseを試みる（後方互換）
    try {
      const parsed = JSON.parse(data.value);
      return { value: data.value }; // 非圧縮データ
    } catch {
      // JSON parse失敗 → 圧縮データとして解凍
      try {
        const decompressed = decompressFromBase64(data.value);
        return { value: decompressed };
      } catch (decompressErr) {
        console.error("解凍失敗:", decompressErr);
        return { value: null };
      }
    }
  } catch (e: any) {
    console.error("DB取得例外:", e);
    return null;
  }
}

// UIコンポーネント
const AuthStatusBar = ({ user, onLogin, onLogout, syncStatus }: {
  user: any;
  onLogin: () => void;
  onLogout: () => void;
  syncStatus: "cloud" | "local";
}) => {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0,
      padding: "10px 18px",
      background: syncStatus === "cloud" ? "#E9F6F1" : "#FFF4E5",
      borderBottom: "0.5px solid rgba(120,120,120,0.15)",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      fontSize: 13, zIndex: 1000
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: syncStatus === "cloud" ? "#0F6E56" : "#F5A623"
        }} />
        <span style={{ fontWeight: 500 }}>
          {syncStatus === "cloud" ? "クラウド同期中" : "ローカルのみ保存"}
        </span>
        {user && (
          <span style={{ color: "#888780", marginLeft: 4, fontSize: 12 }}>
            ({user.email})
          </span>
        )}
      </div>
      <div>
        {user ? (
          <button onClick={onLogout} style={{
            padding: "6px 12px", fontSize: 12,
            background: "none", border: "0.5px solid rgba(120,120,120,0.3)",
            borderRadius: 6, cursor: "pointer", color: "#444441"
          }}>
            ログアウト
          </button>
        ) : (
          <button onClick={onLogin} style={{
            padding: "6px 12px", fontSize: 12,
            background: "#0F6E56", color: "#fff",
            border: "none", borderRadius: 6, cursor: "pointer"
          }}>
            ログイン
          </button>
        )}
      </div>
    </div>
  );
};

const LoginModal = ({ onClose, onLogin }: { onClose: () => void; onLogin: (email: string, password: string) => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("メールとパスワードを入力してください");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onLogin(email, password);
      onClose();
    } catch (err: any) {
      setError(err.message || "ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.5)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 2000
    }}>
      <div style={{
        background: "#fff", padding: 24, borderRadius: 12,
        width: "100%", maxWidth: 400, boxShadow: "0 4px 20px rgba(0,0,0,0.15)"
      }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>ログイン</h2>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>メール</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              style={{ width: "100%", padding: 10, fontSize: 14, border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 6 }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>パスワード</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{ width: "100%", padding: 10, fontSize: 14, border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 6 }}
            />
          </div>
          {error && (
            <div style={{ padding: "8px 12px", background: "#FBEBEB", color: "#A32D2D", borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{
              padding: "8px 16px", fontSize: 13,
              background: "none", border: "0.5px solid rgba(120,120,120,0.3)",
              borderRadius: 6, cursor: "pointer", color: "#444441"
            }}>
              キャンセル
            </button>
            <button type="submit" disabled={loading} style={{
              padding: "8px 16px", fontSize: 13,
              background: "#0F6E56", color: "#fff",
              border: "none", borderRadius: 6, cursor: loading ? "default" : "pointer"
            }}>
              {loading ? "ログイン中..." : "ログイン"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<"cloud" | "local">("local");
  const [showLogin, setShowLogin] = useState(false);

  // 認証SDKを動的ロード
  useEffect(() => {
    (async () => {
      try {
        const authModule = await import("./lib/shared/kliv-auth.js");
        auth = authModule.default;
        await checkAuth();
      } catch (e) {
        console.error("認証SDKロードエラー:", e);
        setLoading(false);
      }
    })();
  }, []);

  const checkAuth = async () => {
    try {
      console.log("認証チェック開始");
      const u = await auth.getUser();
      console.log("認証チェック結果:", u);
      if (u) {
        setUser(u);
        setSyncStatus("cloud");
        // DBにデータがあるかチェック
        const dbRes = await fetch("/api/state?key=rakuten-supp-tracker-v3");
        console.log("DBデータチェック:", dbRes.status);
        if (dbRes.ok) {
          const dbData = await dbRes.json();
          console.log("DBデータ:", dbData);
          // DBにデータがない && localStorageにあるなら自動移行
          const localData = localStorage.getItem("rakuten-supp-tracker-v3");
          if (!dbData.value && localData) {
            console.log("自動移行開始: localStorage -> DB");
            await migrateToDB(localData);
          }
        }
      } else {
        setUser(null);
        setSyncStatus("local");
      }
    } catch (e) {
      console.error("認証チェックエラー:", e);
      setUser(null);
      setSyncStatus("local");
    } finally {
      setLoading(false);
    }
  };

  const migrateToDB = async (data: string) => {
    const result = await saveStateToDB("rakuten-supp-tracker-v3", data);
    if (result.ok) {
      console.log("自動移行成功（圧縮済み）");
      return true;
    } else {
      console.error("自動移行失敗:", result.status);
      return false;
    }
  };

  const handleLogin = async (email: string, password: string) => {
    console.log("ログイン開始:", email);
    try {
      await auth.signIn(email, password);
      console.log("サインイン成功");
      const u = await auth.getUser();
      console.log("ユーザー取得:", u);
      setUser(u);
      setSyncStatus("cloud");
      
      // ログイン後、データ移行チェック
      const dbRes = await fetch("/api/state?key=rakuten-supp-tracker-v3");
      console.log("ログイン後DBチェック:", dbRes.status);
      if (dbRes.ok) {
        const dbData = await dbRes.json();
        console.log("ログイン後DBデータ:", dbData);
        const localData = localStorage.getItem("rakuten-supp-tracker-v3");
        if (!dbData.value && localData) {
          console.log("ログイン後自動移行開始");
          await migrateToDB(localData);
        }
      }
    } catch (e) {
      console.error("ログインエラー:", e);
      throw e;
    }
  };

  const handleLogout = async () => {
    await auth.signOut();
    setUser(null);
    setSyncStatus("local");
  };

  // DBラッパー（ログイン時=DB、未ログイン・エラー時=localStorage）
  if (typeof window !== "undefined") {
    (window as any).storage = {
      async get(key: string) {
        if (user) {
          try {
            // 認証ヘッダーを追加
            const headers: Record<string, string> = {};
            if (user.uuid) headers["x-user-uuid"] = user.uuid;
            
            const result = await loadStateFromDB(key);
            if (result) {
              return result;
            } else {
              console.warn("DB取得エラー、localStorageフォールバック");
              const v = localStorage.getItem(key);
              return v == null ? null : { value: v };
            }
          } catch (e) {
            console.warn("DB取得例外、localStorageフォールバック:", e);
            const v = localStorage.getItem(key);
            return v == null ? null : { value: v };
          }
        } else {
          const v = localStorage.getItem(key);
          return v == null ? null : { value: v };
        }
      },
      async set(key: string, value: string) {
        if (user) {
          try {
            const result = await saveStateToDB(key, value);
            if (result.ok) {
              return true;
            } else {
              console.warn(`DB保存失敗 (HTTP ${result.status})、localStorageフォールバック`);
              localStorage.setItem(key, value);
              return true;
            }
          } catch (e) {
            console.error("DB保存例外、localStorageフォールバック:", e);
            localStorage.setItem(key, value);
            return true;
          }
        } else {
          localStorage.setItem(key, value);
          return true;
        }
      }
    };
  }

  if (loading) {
    return (
      <div style={{ 
        display: "flex", alignItems: "center", justifyContent: "center", 
        height: "100vh", fontSize: 14, color: "#888780" 
      }}>
        読み込み中...
      </div>
    );
  }

  return (
    <>
      <AuthStatusBar
        user={user}
        onLogin={() => setShowLogin(true)}
        onLogout={handleLogout}
        syncStatus={syncStatus}
      />
      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onLogin={handleLogin}
        />
      )}
      <div style={{ paddingTop: 50 }}>
        <SupplementTracker />
      </div>
    </>
  );
}

const css = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #F7F6F2;
    font-family: system-ui, -apple-system, 'Hiragino Sans', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #root { padding: 28px 18px 64px; }
  code { background: rgba(120,120,120,0.12); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);