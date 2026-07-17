import type { Metadata } from "next";
import { Nav } from "./components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "小蜜 · assistant 管理台",
  description: "对话记录、记忆提炼、灵魂与画像",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
