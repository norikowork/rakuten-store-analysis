import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// 楽天の pk_ キーはリファラ(ドメイン)制限付き。本番（kliv.site など登録ドメイン上）では
// ブラウザから実Originが飛ぶので直接動作する。ローカル開発のみプロキシでOriginを偽装する。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const referer = env.VITE_RAKUTEN_REFERER || "";
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/rk-proxy": {
          target: "https://openapi.rakuten.co.jp",
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/rk-proxy/, ""),
          headers: referer ? { Referer: referer, Origin: referer.replace(/\/+$/, "") } : {},
        },
      },
    },
  };
});
