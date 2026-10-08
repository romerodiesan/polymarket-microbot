"use client";

import { Loader2, Play, Power, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type BotAction, useBotStatus } from "@/hooks/use-bot-status";
import { fmtDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusDot, ToneBadge } from "./indicators";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-mono tabular-nums">{children}</dd>
    </>
  );
}

/** Topbar bot status with start/stop: a status pill opening details and logs, plus a one-click action. */
export function BotControl() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<BotAction | null>(null);
  const bot = useBotStatus({ withLog: open });
  const { status, running, stopping, pending, mode } = bot;
  const proc = status?.process;
  const live = mode === "live";
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [status?.log]);

  const state = pending === "start" ? "starting" : stopping || pending === "stop" ? "stopping" : running ? "running" : "stopped";
  const label = { starting: "Iniciando…", stopping: "Deteniendo…", running: "Activo", stopped: "Detenido" }[state];
  const busy = state === "starting" || state === "stopping";

  const run = async (action: BotAction) => {
    setConfirm(null);
    try {
      if (action === "start") {
        await bot.start();
        toast.success("Bot iniciado", { description: status?.series ? `Serie ${status.series}` : undefined });
      } else {
        await bot.stop();
        toast("Deteniendo el bot", { description: "Exporta los datos y se cierra en unos segundos." });
      }
    } catch (error) {
      toast.error(action === "start" ? "No se pudo iniciar el bot" : "No se pudo detener el bot", {
        description: error instanceof Error ? error.message : String(error),
      });
      setOpen(true);
    }
  };

  const request = (action: BotAction) => (action === "stop" || live ? setConfirm(action) : run(action));
  const action: BotAction = running ? "stop" : "start";

  if (!status) return null;

  return (
    <>
      {mode && (
        <ToneBadge tone={live ? "red" : "neutral"} className="font-mono uppercase max-sm:hidden">
          {mode}
        </ToneBadge>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
            aria-label={`Bot ${label.toLowerCase()}; ver detalles`}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <StatusDot active={running} />}
            <span>{label}</span>
            {bot.lagSeconds !== null && running && (
              <span className="hidden font-mono tabular-nums text-muted-foreground sm:inline">{Math.round(bot.lagSeconds)}s</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Power className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Bot</span>
              <ToneBadge tone={live ? "red" : "neutral"} className="font-mono uppercase">{mode}</ToneBadge>
            </div>
            <span className="flex items-center gap-1.5 text-xs">
              <StatusDot active={running} />
              {label}
            </span>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-xs">
            <Row label="Mercado">{status.series ?? "Tokens fijos"}</Row>
            {running && proc ? (
              <>
                <Row label="PID">{proc.pid}</Row>
                <Row label="En marcha">{bot.uptimeSeconds !== null ? fmtDuration(bot.uptimeSeconds) : "—"}</Row>
                <Row label="Origen">{proc.managed ? "Dashboard" : "Terminal"}</Row>
              </>
            ) : (
              proc?.lastExit && (
                <Row label="Última ejecución">
                  código {proc.lastExit.code ?? "—"}
                  {bot.sinceExitSeconds !== null && ` · hace ${fmtDuration(bot.sinceExitSeconds)}`}
                </Row>
              )
            )}
            <Row label="Último export">{bot.lagSeconds !== null ? `hace ${fmtDuration(bot.lagSeconds)}` : "—"}</Row>
          </dl>

          {running && proc && !proc.managed ? (
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
              Iniciado desde una terminal: su log está allí. Puedes detenerlo desde aquí.
            </p>
          ) : (
            status.log && (
              <pre
                ref={logRef}
                className="max-h-52 overflow-auto border-t bg-muted/40 px-4 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground"
              >
                {status.log.trim()}
              </pre>
            )
          )}

          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            <Button
              size="sm"
              variant={running ? "destructive" : "default"}
              disabled={busy}
              onClick={() => request(action)}
            >
              {busy ? <Loader2 className="animate-spin" /> : running ? <Square /> : <Play />}
              {running ? "Detener bot" : "Iniciar bot"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        variant={running ? "outline" : "default"}
        disabled={busy}
        onClick={() => request(action)}
        className={cn("h-8 gap-1.5", running && "text-destructive hover:text-destructive")}
        aria-label={running ? "Detener bot" : "Iniciar bot"}
      >
        {busy ? <Loader2 className="animate-spin" /> : running ? <Square className="fill-current" /> : <Play className="fill-current" />}
        <span className="max-sm:hidden">{running ? "Detener" : "Iniciar"}</span>
      </Button>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "stop" ? "¿Detener el bot?" : "¿Iniciar el bot en modo LIVE?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "stop"
                ? "Deja de operar y de recopilar datos. Exporta lo pendiente antes de cerrarse; las posiciones abiertas no se venden."
                : "Operará con dinero real en Polymarket usando la configuración del .env."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "stop" || live ? "destructive" : "default"} onClick={() => confirm && run(confirm)}>
              {confirm === "stop" ? "Detener" : "Iniciar en LIVE"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
