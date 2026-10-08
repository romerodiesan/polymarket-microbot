"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type LoginState, login } from "./actions";

export default function LoginForm() {
  const next = useSearchParams().get("next") ?? "/";
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="grid gap-2">
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          aria-invalid={!!state.error}
          aria-describedby={state.error ? "login-error" : undefined}
        />
        {state.error && (
          <p id="login-error" role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {state.error}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending && <Loader2 className="animate-spin" />}
        {pending ? "Comprobando…" : "Entrar"}
      </Button>
    </form>
  );
}
