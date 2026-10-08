import { Activity, BrainCircuit, Database } from "lucide-react";

export const NAV_LINKS = [
  { href: "/", label: "En vivo", icon: Activity },
  { href: "/data", label: "Datos", icon: Database },
  { href: "/training", label: "Entrenamiento", icon: BrainCircuit },
] as const;

export const isActiveLink = (href: string, pathname: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);
