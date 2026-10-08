"use client";

import { ChevronDown, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { LiveControlsState } from "./use-live-controls";

export function LayerSwitches({ c }: { c: LiveControlsState }) {
  const layers = [
    { id: "layer-bidask", label: "Bid / Ask", hint: "Líneas de mejor compra y venta", key: "B", checked: c.showBidAsk, onChange: c.setShowBidAsk },
    { id: "layer-fills", label: "Fills", hint: "Marcas de órdenes ejecutadas", key: "F", checked: c.showFills, onChange: c.setShowFills },
  ];
  return (
    <div className="grid gap-3">
      {layers.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-4">
          <Label htmlFor={l.id} className="grid gap-0.5 font-normal">
            <span className="flex items-center gap-2 text-sm font-medium">
              {l.label}
              <Kbd className="hidden md:inline-flex">{l.key}</Kbd>
            </span>
            <span className="text-xs text-muted-foreground">{l.hint}</span>
          </Label>
          <Switch id={l.id} checked={l.checked} onCheckedChange={l.onChange} />
        </div>
      ))}
    </div>
  );
}

export function LayersPopover({ c }: { c: LiveControlsState }) {
  const active = Number(c.showBidAsk) + Number(c.showFills);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
          <Layers />
          Capas
          <span className="font-mono text-muted-foreground">{active}/2</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="mb-3 text-sm font-medium">Capas de precio</p>
        <LayerSwitches c={c} />
      </PopoverContent>
    </Popover>
  );
}
