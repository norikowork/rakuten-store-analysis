import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import SupplementTracker from "./SupplementTracker";

// UIコンポーネント
const RecoveryButton = ({ onRecover, hasLocalData }: { onRecover: () => void; hasLocalData: boolean }) => {
  if (!hasLocalData) return null;
  return (
    <div style={{
      position: "fixed", top: 12, right: 12,
      padding: "10px 14px", background: "#A32D2D", color: "#fff",
      borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer",
      zIndex: 9999, boxShadow: "0 2px 8px rgba(0,0,0,0.15)"
    }} onClick={onRecover}>
      このブラウザのデータをDBに保存（復旧）
    </div>
  );
};

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showRecovery, setShowRecovery] = useState(false);
  const [hasLocalData, setHasLocalData] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // 認証状態をチェック
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      console.log("認証チェック開始");
      const res = await fetch("/api/v2/auth/user");
      console.log("認証レスポンス:", res.status);
      if (res.ok) {
        const data = await res.json();
        const u = data.user;
        console.log("ユーザー認証成功:", u);
        setUser(u);
        // ログイン済みならlocalStorageのデータチェック
        const localData = localStorage.getItem("rakuten-supp-tracker-v3");
        console.log("localStorageデータ:", localData ? "あり" : "なし");
        setHasLocalData(!!localData);
        
        // DBにデータがあるかチェック
        const dbRes = await fetch("/api/state?key=rakuten-supp-tracker-v3");
        console.log("DBレスポンス:", dbRes.status);
        if (dbRes.ok) {
          const dbData = await dbRes.json();
          console.log("DBデータ:", dbData);
          // DBにデータがない && localStorageにあるなら自動移行
          if (!dbData.value && localData) {
            console.log("自動移行開始: localStorage -> DB");
            await migrateToDB(localData);
          }
        }
        setShowRecovery(true);
      } else {
        console.log("ユーザー未認証");
        setUser(null);
      }
    } catch (e) {
      console.error("認証チェックエラー:", e);
      setAuthError("認証エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const migrateToDB = async (data: string) => {
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "rakuten-supp-tracker-v3", value: data })
      });
      if (res.ok) {
        console.log("自動移行成功");
        return true;
      } else {
        console.error("自動移行失敗:", res.status);
        return false;
      }
    } catch (e) {
      console.error("自動移行例外:", e);
      return false;
    }
  };

  const handleRecovery = async () => {
    const localData = localStorage.getItem("rakuten-supp-tracker-v3");
    if (!localData) {
      alert("復旧するデータがありません");
      return;
    }

    if (!confirm("このブラウザのデータをDBに上書き保存します。よろしいですか？")) {
      return;
    }

    const success = await migrateToDB(localData);
    if (success) {
      alert("復旧完了！ページをリロードします");
      window.location.reload();
    } else {
      alert("復旧に失敗しました");
    }
  };

  // DBラッパー
  if (typeof window !== "undefined") {
    (window as any).storage = {
      async get(key: string) {
        try {
          const res = await fetch(`/api/state?key=${key}`);
          if (res.ok) {
            const data = await res.json();
            return data;
          } else {
            // DB失敗時はlocalStorageフォールバック
            const v = localStorage.getItem(key);
            return v == null ? null : { value: v };
          }
        } catch (e) {
          console.error("DB取得エラー、localStorageフォールバック:", e);
          const v = localStorage.getItem(key);
          return v == null ? null : { value: v };
        }
      },
      async set(key: string, value: string) {
        try {
          const res = await fetch("/api/state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value })
          });
          if (res.ok) {
            return true;
          } else {
            // DB失敗時はlocalStorageフォールバック
            localStorage.setItem(key, value);
            return true;
          }
        } catch (e) {
          console.error("DB保存エラー、localStorageフォールバック:", e);
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
      {showRecovery && user && <RecoveryButton onRecover={handleRecovery} hasLocalData={hasLocalData} />}
      <SupplementTracker />
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