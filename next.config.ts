import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["192.168.1.115"],
  // 全站禁止搜尋引擎收錄：netlify.toml也有設定同一個header（正式部署到Netlify時生效），
  // 這裡另外設定一份是為了本機開發/測試（npm run dev、npm start）跟非Netlify環境也能收到這個header。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
        ],
      },
    ];
  },
};

export default nextConfig;
