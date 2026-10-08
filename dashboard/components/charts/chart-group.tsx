"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type {
  IChartApi,
  IRange,
  ISeriesApi,
  Logical,
  MouseEventParams,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

/** A user wheel/drag/touch on a chart within this window marks its range change as user-driven. */
const USER_INPUT_MS = 800;
const USER_EVENTS = ["wheel", "mousedown", "touchstart", "dblclick", "keydown"] as const;

/** How one chart frames time: the last `windowSec` up to the group edge while `following` (Infinity = all data). */
export type ChartViewport = {
  windowSec: number;
  following: boolean;
  onFollowingChange: (following: boolean) => void;
};

export type GroupMember = {
  chart: IChartApi;
  element: HTMLElement;
  /** Series the synced crosshair snaps to. */
  mainSeries: () => ISeriesApi<SeriesType> | null;
  viewport: () => ChartViewport;
};

type GroupApi = {
  register: (member: GroupMember) => () => void;
  /** Call after replacing a member's data: re-applies the live window or the user's view. */
  afterData: (member: GroupMember, previous: IRange<Time> | null) => void;
  /** Call when a member's viewport changes. */
  refresh: (member: GroupMember) => void;
};

const GroupContext = createContext<GroupApi | null>(null);

/** lightweight-charts throws on setVisibleRange while a chart has no data yet. */
function setRange(member: GroupMember, range: IRange<Time>) {
  if (!member.mainSeries()?.data().length) return;
  member.chart.timeScale().setVisibleRange(range);
}

export const useChartGroup = () => useContext(GroupContext);

/**
 * Charts sharing one clock: the crosshair moves across all of them and each one that is
 * following its viewport keeps its own window ending at `edge`. Panning or zooming a chart
 * only stops that chart from following.
 */
export function ChartGroup({ edge, children }: { edge: number; children: React.ReactNode }) {
  const members = useRef(new Set<GroupMember>());
  const lastInput = useRef(new Map<GroupMember, number>());
  const hovered = useRef<GroupMember | null>(null);
  const edgeRef = useRef(edge);

  useEffect(() => {
    edgeRef.current = edge;
  });

  const applyWindow = useCallback((member: GroupMember) => {
    const { windowSec } = member.viewport();
    const edge = edgeRef.current;
    if (!Number.isFinite(windowSec)) member.chart.timeScale().fitContent();
    else setRange(member, { from: (edge - windowSec) as UTCTimestamp, to: edge as UTCTimestamp });
  }, []);

  const api = useMemo<GroupApi>(() => ({
    register(member) {
      members.current.add(member);
      const markInput = () => lastInput.current.set(member, performance.now());
      for (const type of USER_EVENTS) member.element.addEventListener(type, markInput, { passive: true });

      const onRange = (range: IRange<Time> | null) => {
        const at = lastInput.current.get(member);
        if (!range || at === undefined || performance.now() - at > USER_INPUT_MS) return;
        const viewport = member.viewport();
        if (viewport.following) viewport.onFollowingChange(false);
      };

      const onCrosshair = (param: MouseEventParams<Time>) => {
        // Synthetic moves (from setCrosshairPosition) carry no source event; don't echo them.
        if (param.point && !param.sourceEvent) return;
        if (!param.point || param.time === undefined) {
          if (hovered.current !== member) return;
          hovered.current = null;
          for (const other of members.current) if (other !== member) other.chart.clearCrosshairPosition();
          return;
        }
        hovered.current = member;
        for (const other of members.current) {
          if (other === member) continue;
          const series = other.mainSeries();
          const index = other.chart.timeScale().timeToIndex(param.time, true);
          const bar = series && index !== null ? series.dataByIndex(index as number as Logical) : null;
          if (!series || !bar) {
            other.chart.clearCrosshairPosition();
            continue;
          }
          const price = Number("value" in bar ? bar.value : "close" in bar ? bar.close : NaN);
          if (!Number.isFinite(price)) continue;
          other.chart.setCrosshairPosition(price, bar.time, series);
        }
      };

      member.chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
      member.chart.subscribeCrosshairMove(onCrosshair);
      if (member.viewport().following) applyWindow(member);
      return () => {
        member.chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
        member.chart.unsubscribeCrosshairMove(onCrosshair);
        for (const type of USER_EVENTS) member.element.removeEventListener(type, markInput);
        members.current.delete(member);
        lastInput.current.delete(member);
        if (hovered.current === member) hovered.current = null;
      };
    },
    afterData(member, previous) {
      if (member.viewport().following) applyWindow(member);
      else if (previous) setRange(member, previous);
    },
    refresh(member) {
      if (member.viewport().following) applyWindow(member);
    },
  }), [applyWindow]);

  useEffect(() => {
    for (const member of members.current) {
      if (member.viewport().following) applyWindow(member);
    }
  }, [edge, applyWindow]);

  return <GroupContext.Provider value={api}>{children}</GroupContext.Provider>;
}
