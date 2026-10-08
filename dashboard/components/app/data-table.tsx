"use client";

import { Inbox } from "lucide-react";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmptyState } from "./page";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Right-aligned, monospaced, tabular digits. */
  numeric?: boolean;
  /** Tooltip on the header, e.g. to explain the metric. */
  hint?: string;
  /** Hidden below the md breakpoint to keep phones readable. */
  hideOnMobile?: boolean;
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "Sin datos.",
  maxHeight,
  stickyFirstColumn = true,
  onRowClick,
  selectedKey,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: React.ReactNode;
  maxHeight?: number;
  stickyFirstColumn?: boolean;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
}) {
  if (!rows.length) return <EmptyState icon={Inbox} title="Sin datos">{empty}</EmptyState>;
  // Opaque backgrounds so the sticky header/column hide content scrolling beneath them.
  const stickyCell = "sticky left-0 z-[1] shadow-[1px_0_0_0_var(--border)]";
  return (
    <div
      className="relative w-full overflow-auto overscroll-x-contain rounded-lg border"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((col, i) => (
              <TableHead
                key={col.key}
                scope="col"
                className={cn(
                  "sticky top-0 z-[2] h-9 border-b bg-muted px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                  col.numeric && "text-right",
                  col.hideOnMobile && "hidden md:table-cell",
                  i === 0 && stickyFirstColumn && `${stickyCell} z-[3]`,
                )}
              >
                {col.hint ? (
                  <Tooltip>
                    <TooltipTrigger className="cursor-help uppercase underline decoration-dotted underline-offset-4">
                      {col.header}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64 normal-case">{col.hint}</TooltipContent>
                  </Tooltip>
                ) : (
                  col.header
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => {
            const key = rowKey(row, r);
            const selected = selectedKey === key;
            return (
              <TableRow
                key={key}
                data-state={selected ? "selected" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                aria-selected={onRowClick ? selected : undefined}
                className={cn(
                  "group border-0 hover:bg-transparent",
                  onRowClick && "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                )}
              >
                {columns.map((col, i) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      "border-b bg-card px-3 py-2 group-last:border-b-0 group-hover:bg-accent",
                      selected && "bg-muted group-hover:bg-muted",
                      col.numeric && "text-right font-mono tabular-nums",
                      col.hideOnMobile && "hidden md:table-cell",
                      i === 0 && stickyFirstColumn && stickyCell,
                      col.className,
                    )}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </table>
    </div>
  );
}
