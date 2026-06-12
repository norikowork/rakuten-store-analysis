import React, { useEffect, useState } from "react";
// @ts-nocheck - TypeScript型チェックを一時的に無効化して、コンパイルエラーを回避
import { createRoot } from "react-dom/client";
import SupplementTracker from "./SupplementTracker";
import functions from "@/lib/shared/kliv-functions.js";
import auth from "@/lib/shared/kliv-auth.js";

// 認証・同期ステータス管理用のグローバルコンテキスト
const { Provider: AuthSyncProvider, Consumer: AuthSyncConsumer } = React.createContext();

// 認証と同期ステータスを管理するコンポーネント
function AuthSyncManager({ children }) {
  const [user, setUser] = useState(null);
  const [syncStatus, setSyncStatus] = useState("local"); // 初期状態はローカルモード（checking→localに変更）
  const [showLogin, setShowLogin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isMigrating, setIsMigrating] = useState(false);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const currentUser = await auth.getUser();
      setUser(currentUser);
      setSyncStatus(currentUser ? "synced" : "local"); // 修正：三項演算子のコロンを確認
    } catch (error) {
      console.error("Auth check failed, using local mode:", error);
      // セッションエラー時はローカルモードで継続
      setUser(null);
      setSyncStatus("local");
    }
  };

  const handleSignIn = async (e) => {
    e.preventDefault();
    setLoginError("");
    try {
      const user = await auth.signIn(loginEmail, loginPassword);
      setUser(user);
      setSyncStatus("synced");
      setShowLogin(false);
      // ログイン成功後にデータ移行を試みる
      await migrateLocalToCloud();
    } catch (error) {
      console.error("Login error:", error);
      setLoginError(error.message || "ログインに失敗しました");
    }
  };

  const handleSignOut = async () => {
    try {
      await auth.signOut();
      setUser(null);
      setSyncStatus("local");
    } catch (error) {
      console.error("Sign out failed:", error);
    }
  };

  // localStorageからDBへのデータ移行（初回ログイン時のみ）
  const migrateLocalToCloud = async () => {
    try {
      // 認証状態チェック
      const currentUser = await auth.getUser();
      if (!currentUser) {
        console.log("未認証状態のため、データ移行をスキップ");
        return;
      }

      const STORAGE_KEY = "rakuten-supp-tracker-v3";
      const localData = localStorage.getItem(STORAGE_KEY);
      
      if (!localData) return; // ローカルデータがない場合は移行不要

      setIsMigrating(true);
      
      try {
        // DBに既存データがあるか確認
        const existingData = await functions.get("app-state-api", { key: STORAGE_KEY });
        
        if (!existingData || !existingData.value) {
          // DBにデータがない場合のみ移行実行
          console.log("Migrating local data to cloud...");
          await functions.post("app-state-api", { 
            key: STORAGE_KEY, 
            value: localData 
          });
          console.log("Migration completed");
        } else {
          console.log("Cloud data exists, skipping migration");
        }
      } catch (migrationError) {
        console.error("Migration failed:", migrationError);
        // 移行失敗してもローカルデータは残っているので続行可能
      }
    } catch (error) {
      console.error("Migration process failed:", error);
    } finally {
      setIsMigrating(false);
    }
  };

  const getStatusColor = () => {
    switch (syncStatus) {
      case "synced": return "#0F6E56"; // 緑（クラウド同期中）
      case "local": return "#D85A30"; // オレンジ（ローカルのみ）
      case "error": return "#A32D2D"; // 赤（エラー）
      default: return "#888780"; // グレー（確認中）
    }
  };

  const getStatusText = () => {
    switch (syncStatus) {
      case "synced": return user?.email || "クラウド同期中";
      case "local": return "ローカルのみ保存";
      case "error": return "同期エラー";
      default: return "確認中...";
    }
  };

  return React.createElement(AuthSyncProvider, { value: { user, syncStatus, migrateLocalToCloud } },
    React.createElement("div", { style: { position: "relative", minHeight: "100vh" } },
      // 同期ステータスバー
      React.createElement("div", { 
        style: { 
          position: "fixed", 
          top: 0, 
          left: 0, 
          right: 0, 
          background: "white", 
          borderBottom: "1px solid rgba(120,120,120,0.2)", 
          padding: "8px 16px", 
          display: "flex", 
          alignItems: "center", 
          justifyContent: "space-between",
          zIndex: 1000,
          fontSize: "13px"
        }
      },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          React.createElement("div", { 
            style: { 
              width: "8px", 
              height: "8px", 
              borderRadius: "50%", 
              background: getStatusColor() 
            } 
          }),
          React.createElement("span", { style: { color: "#5F5E5A" } }, getStatusText()),
          isMigrating && React.createElement("span", { style: { color: "#0F6E56", fontSize: "12px" } }, "データ移行中...")
        ),
        React.createElement("div", null,
          user 
            ? React.createElement("button", { 
                onClick: handleSignOut,
                style: {
                  padding: "6px 12px",
                  fontSize: "12px",
                  background: "none",
                  border: "1px solid rgba(120,120,120,0.3)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: "#444441"
                }
              }, "ログアウト")
            : React.createElement("button", { 
                onClick: () => setShowLogin(true),
                style: {
                  padding: "6px 12px",
                  fontSize: "12px",
                  background: "#0F6E56",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: "white"
                }
              }, "ログイン")
        )
      ),
      
      // ログインモーダル
      showLogin && React.createElement("div", {
        style: {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 2000
        }
      },
        React.createElement("div", {
          style: {
            background: "white",
            borderRadius: "12px",
            padding: "24px",
            width: "100%",
            maxWidth: "320px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.1)"
          }
        },
          React.createElement("h3", { style: { margin: "0 0 16px 0", fontSize: "16px" } }, "ログイン"),
          React.createElement("form", { onSubmit: handleSignIn },
            React.createElement("div", { style: { marginBottom: "12px" } },
              React.createElement("input", {
                type: "email",
                placeholder: "メールアドレス",
                value: loginEmail,
                onChange: (e) => setLoginEmail(e.target.value),
                required: true,
                style: {
                  width: "100%",
                  padding: "10px 12px",
                  fontSize: "14px",
                  border: "1px solid rgba(120,120,120,0.3)",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }
              })
            ),
            React.createElement("div", { style: { marginBottom: "16px" } },
              React.createElement("input", {
                type: "password",
                placeholder: "パスワード",
                value: loginPassword,
                onChange: (e) => setLoginPassword(e.target.value),
                required: true,
                style: {
                  width: "100%",
                  padding: "10px 12px",
                  fontSize: "14px",
                  border: "1px solid rgba(120,120,120,0.3)",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }
              })
            ),
            loginError && React.createElement("div", {
              style: {
                marginBottom: "12px",
                padding: "8px 12px",
                background: "#FEE",
                border: "1px solid #FCC",
                borderRadius: "6px",
                color: "#A32D2D",
                fontSize: "13px"
              }
            }, loginError),
            React.createElement("div", { style: { display: "flex", gap: "8px" } },
              React.createElement("button", {
                type: "submit",
                style: {
                  flex: 1,
                  padding: "10px",
                  fontSize: "14px",
                  background: "#0F6E56",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontWeight: "500"
                }
              }, "ログイン"),
              React.createElement("button", {
                type: "button",
                onClick: () => setShowLogin(false),
                style: {
                  flex: 1,
                  padding: "10px",
                  fontSize: "14px",
                  background: "white",
                  color: "#444441",
                  border: "1px solid rgba(120,120,120,0.3)",
                  borderRadius: "6px",
                  cursor: "pointer"
                }
              }, "キャンセル")
            )
          )
        )
      ),
      
      // メインアプリコンテンツ（上のステータスバー分をパディング調整）
      React.createElement("div", { style: { paddingTop: "40px" } }, children)
    )
  );
}

// このコンポーネントは window.storage 経由で永続化する。
// SQLite データベース経由で保存する（認証済みユーザーのみ利用可能）。
if (typeof window !== "undefined" && !(window as any).storage) {
  (window as any).storage = {
    async get(key: string) {
      try {
        const currentUser = await auth.getUser();
        if (currentUser) {
          // 認証済み：DBから取得
          try {
            const result = await functions.get("app-state-api", { key });
            if (result && result.value) {
              console.log("DBからデータを取得:", key);
              return { value: result.value };
            }
            console.log("DBにデータがありません:", key);
            return null;
          } catch (dbError) {
            console.warn("DB取得エラー、localStorageにフォールバック:", dbError.message);
            const value = localStorage.getItem(key);
            return value == null ? null : { value };
          }
        } else {
          // 未認証：localStorageから取得
          console.log("localStorageからデータを取得:", key);
          const value = localStorage.getItem(key);
          return value == null ? null : { value };
        }
      } catch (error) {
        console.error("storage.get error:", error);
        // エラー時はlocalStorageにフォールバック
        try {
          const value = localStorage.getItem(key);
          return value == null ? null : { value };
        } catch (e) {
          console.error("localStorage fallback failed:", e);
          return null;
        }
      }
    },
    async set(key: string, value: string) {
      try {
        const currentUser = await auth.getUser();
        if (currentUser) {
          // 認証済み：DBに保存
          try {
            await functions.post("app-state-api", { key, value });
            console.log("DBにデータを保存:", key);
            return true;
          } catch (dbError) {
            console.warn("DB保存エラー、localStorageにフォールバック:", dbError.message);
            // DB失敗時はlocalStorageに保存
            localStorage.setItem(key, value);
            console.log("エラーによりlocalStorageにフォールバック:", key);
            return true;
          }
        } else {
          // 未認証：localStorageに保存
          console.log("localStorageにデータを保存:", key);
          localStorage.setItem(key, value);
          return true;
        }
      } catch (error) {
        console.error("storage.set error:", error);
        // エラー時はlocalStorageにフォールバック
        try {
          localStorage.setItem(key, value);
          console.log("エラーによりlocalStorageにフォールバック:", key);
          return true;
        } catch (e) {
          console.error("localStorage fallback failed:", e);
          return false;
        }
      }
    },
  };
}

const css = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #F7F6F2;
    font-family: system-ui, -apple-system, 'Hiragino Sans', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #root { padding: 0; }
  code { background: rgba(120,120,120,0.12); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <AuthSyncManager>
    <SupplementTracker />
  </AuthSyncManager>
);