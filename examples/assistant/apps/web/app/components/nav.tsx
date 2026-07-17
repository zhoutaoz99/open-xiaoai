"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const kLinks = [
  { href: "/", label: "对话与提炼" },
  { href: "/memories", label: "记忆库" },
  { href: "/profile", label: "画像" },
  { href: "/soul", label: "灵魂" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="sidebar">
      <div className="brand">
        小蜜
        <small>assistant 管理台</small>
      </div>
      {kLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`nav-link${pathname === link.href ? " active" : ""}`}
        >
          {link.label}
        </Link>
      ))}
      <div className="sidebar-foot">
        灵魂是设定的，画像是习得的。
        <br />
        清空记忆不碰灵魂。
      </div>
    </nav>
  );
}
