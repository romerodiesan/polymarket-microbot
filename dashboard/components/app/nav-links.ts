import { Activity, BrainCircuit, Database, Scale } from "lucide-react";

export const NAV_LINKS = [
  { href: "/", label: "En vivo", icon: Activity },
  { href: "/data", label: "Datos", icon: Database },
  { href: "/training", label: "Entrenamiento", icon: BrainCircuit },
  { href: "/evaluation", label: "Evaluación", icon: Scale },
] as const;

export const isActiveLink = (href: string, pathname: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);
