import { Bot } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import LoginForm from "./login-form";

export const metadata: Metadata = { title: "Acceso · Microbot Dashboard" };

export default function LoginPage() {
  return (
    <main className="relative flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div className="absolute right-3 top-3">
        <ThemeToggle />
      </div>
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Polymarket Microbot</span>
        </div>
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-xl">Iniciar sesión</CardTitle>
            <CardDescription>Introduce la contraseña del dashboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense>
              <LoginForm />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
