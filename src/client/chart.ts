/**
 * 置信度追踪图。
 *
 * 每回合记录该回合概率分布的三个统计量：
 *   上界 = 最高概率   下界 = 最低概率   中线 = 中位概率
 * 用上下界之间的带状面积表达「Jev 这一手有多分散」，
 * 中线带点标出中位数走势。带状越窄 → Jev 越笃定。
 */
import type { TurnLog } from "../shared/types.js";
import { t } from "./i18n.js";

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 10;
const PAD_B = 12;
const MAX_POINTS = 120;

export class ConfidenceChart {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private data: TurnLog[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error(t("err.noCanvas"));
    this.ctx = ctx;
  }

  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setData(rows: TurnLog[]): void {
    this.data = rows.slice(-MAX_POINTS);
    this.draw();
  }

  push(row: TurnLog): void {
    // 调用失败的回合没有分布数据，画上去会在图上砸出一个 0 的坑，跳过
    if (row.failed) {
      this.draw();
      return;
    }
    this.data.push(row);
    if (this.data.length > MAX_POINTS) this.data.shift();
    this.draw();
  }

  clear(): void {
    this.data = [];
    this.draw();
  }

  /**
   * 只重绘，不动数据。
   *
   * 画布上的文案（如「等待对局数据」）是绘制那一刻写死的，切换界面语言后
   * 不重绘就会一直停在旧语言。`clear()` 不能用 —— 它会把曲线一起清掉。
   */
  redraw(): void {
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const { w, h } = this;
    if (w <= 0 || h <= 0) return;

    ctx.clearRect(0, 0, w, h);

    const plotW = w - PAD_L - PAD_R;
    const plotH = h - PAD_T - PAD_B;
    if (plotW <= 4 || plotH <= 4) return;

    const yOf = (v: number): number => PAD_T + (1 - Math.max(0, Math.min(1, v))) * plotH;

    // 网格：0 / 0.5 / 1
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (const g of [0, 0.5, 1]) {
      const y = Math.round(yOf(g)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(w - PAD_R, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 轴标签
    ctx.fillStyle = "rgba(255,255,255,.28)";
    ctx.font = '9px ui-monospace, "Geist Mono", monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("1.0", PAD_L + 1, PAD_T + 0.5);
    ctx.textBaseline = "bottom";
    ctx.fillText("0.0", PAD_L + 1, h - PAD_B - 0.5);

    const d = this.data;
    if (d.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,.22)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(t("chart.waiting"), w / 2, h / 2);
      return;
    }

    const n = d.length;
    const xOf = (i: number): number =>
      n === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW;

    // 带状：上界 → 下界闭合
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i);
      const y = yOf(d[i].top);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(d[i].bottom));
    ctx.closePath();

    const band = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
    band.addColorStop(0, "rgba(245,158,11,.30)");
    band.addColorStop(1, "rgba(245,158,11,.06)");
    ctx.fillStyle = band;
    ctx.fill();

    // 中位线
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i);
      const y = yOf(d[i].median);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // 数据点（点多时抽稀，避免糊成一片）
    const step = n > 48 ? Math.ceil(n / 48) : 1;
    ctx.fillStyle = "#fbbf24";
    for (let i = 0; i < n; i += step) {
      ctx.beginPath();
      ctx.arc(xOf(i), yOf(d[i].median), 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // 末点强调
    if (n > 0) {
      const lx = xOf(n - 1);
      const ly = yOf(d[n - 1].median);
      ctx.beginPath();
      ctx.arc(lx, ly, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "#fff7e6";
      ctx.fill();
    }
  }
}
