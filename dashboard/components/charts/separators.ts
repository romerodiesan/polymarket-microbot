import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { type ChartTheme, getChartTheme } from "./theme";

export type Separator = { ts: number; label?: string };

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Dashed vertical lines across the pane (e.g. market rollovers), with an optional label on top. */
export class SeparatorsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private lines: Separator[] = [];
  private colors = { line: getChartTheme("dark").separator, text: getChartTheme("dark").separatorText };
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => "bottom", renderer: () => renderer };
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.requestUpdate = null;
  }

  setLines(lines: Separator[], theme: ChartTheme) {
    this.lines = lines;
    this.colors = { line: theme.separator, text: theme.separatorText };
    this.requestUpdate?.();
  }

  paneViews() {
    return [this.view];
  }

  private draw(target: Target) {
    const timeScale = this.chart?.timeScale();
    if (!timeScale || !this.lines.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.save();
      ctx.strokeStyle = this.colors.line;
      ctx.fillStyle = this.colors.text;
      ctx.lineWidth = Math.max(1, Math.floor(hr));
      ctx.setLineDash([4 * hr, 4 * hr]);
      ctx.font = `${10 * vr}px ui-monospace, monospace`;
      for (const line of this.lines) {
        // Separators rarely fall exactly on a bar; snap to the nearest one.
        const index = timeScale.timeToIndex(line.ts as UTCTimestamp, true);
        const coordinate = index === null ? null : timeScale.logicalToCoordinate(index as number as Logical);
        if (coordinate === null) continue;
        const x = Math.round(coordinate * hr) + 0.5;
        if (x < 0 || x > bitmapSize.width) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, bitmapSize.height);
        ctx.stroke();
        if (line.label) ctx.fillText(line.label, x + 4 * hr, 12 * vr);
      }
      ctx.restore();
    });
  }
}
