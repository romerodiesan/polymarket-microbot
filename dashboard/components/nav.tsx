"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "En vivo" },
  { href: "/data", label: "Datos" },
  { href: "/training", label: "Entrenamiento" },
] as const;

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-white/10 bg-black/30">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 sm:gap-6 md:px-6">
        <span className="shrink-0 whitespace-nowrap py-3 font-semibold">
          <span className="sm:hidden">Microbot</span>
          <span className="hidden sm:inline">Polymarket Microbot</span>
        </span>
        <div className="-mr-4 flex min-w-0 gap-1 overflow-x-auto pr-4 text-sm sm:mr-0 sm:pr-0">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 ${active ? "bg-white/15 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"}`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
