/**
 * Canvas 棋盘渲染。
 *
 * 为什么用 canvas 而不是 DOM：
 * DOM 绝对定位依赖 clientWidth 的测量时机，字体加载、滚动条出现都会让缓存值失真，
 * 导致最后一列/行越界、或字号算成 0 而数字消失。canvas 里每个像素都由自己算，
 * 这类问题从根上不存在。
 *
 * 视觉：暖橙色阶，暗褐 → 琥珀 → 金黄，靠明度对比区分空格子与数字格。
 */
import { SIZE, type Direction, type Tile } from "../shared/types.js";

interface Swatch {
  bg: string;
  fg: string;
  glow?: boolean;
}

/**
 * 橙色阶：亮度与饱和度**同时**递增，不是单纯的灰度明暗。
 * 相邻两级亮度差约 6–8 个百分点，保证肉眼可分辨。
 * 前三级文字用浅色（底暗），从 128 起翻转为深色（底亮）。
 */
const SCALE: Record<number, Swatch> = {
  1:    { bg: "#2a2521", fg: "#8c7f70" },
  2:    { bg: "#382f27", fg: "#a8998a" },
  4:    { bg: "#4a3b28", fg: "#c7b49c" },
  8:    { bg: "#5f4722", fg: "#e3cdae" },
  16:   { bg: "#76511a", fg: "#f5dfc2" },
  32:   { bg: "#8e5c12", fg: "#ffeacd" },
  64:   { bg: "#a76a0b", fg: "#fff2da" },
  128:  { bg: "#c07a07", fg: "#2a1c00" },
  256:  { bg: "#d98c07", fg: "#2a1c00" },
  512:  { bg: "#f0a012", fg: "#2a1c00", glow: true },
  1024: { bg: "#ffb833", fg: "#2a1c00", glow: true },
  2048: { bg: "#ffd166", fg: "#2a1c00", glow: true },
};

const swatch = (v: number): Swatch =>
  SCALE[v] ?? { bg: "#fff0c2", fg: "#2a1c00", glow: true };

/** 棋子动画状态：位置以「格」为单位（可含小数），与像素尺寸解耦 */
interface Visual {
  value: number;
  x: number;
  y: number;
  scale: number;
  alpha: number;
  tx: number;
  ty: number;
  tScale: number;
  tAlpha: number;
  dying: boolean;
}

/** 决策方向粒子：沿该方向飘散的箭头，由大变小、由实变虚 */
interface Particle {
  /** 格坐标 */
  x: number;
  y: number;
  /** 速度，格/秒 */
  vx: number;
  vy: number;
  /** 初始字号占**格子边长**的比例 */
  size: number;
  /** 已存活秒数 */
  age: number;
  ttl: number;
  glyph: string;
}

/** 每帧插值比例；tick 内按实际帧间隔归一化 */
const EASE = 0.28;
/** 单颗粒子的存活时长（秒） */
const PARTICLE_TTL = 0.62;
/**
 * 每个「发生变化」的格子撒出的粒子数区间（含两端）。
 * 只在实际动过的格子上生成，空格子保持干净。
 */
const PARTICLE_PER_CELL_MIN = 2;
const PARTICLE_PER_CELL_MAX = 4;
/**
 * 粒子初始字号相对**格子边长**的比例区间。
 * 相对格子而非棋盘，这样换棋盘尺寸时视觉比例恒定。
 * 均值约 0.44 格 —— 约为上一版（按棋盘边长算）的一半。
 */
const PARTICLE_SIZE_MIN = 0.32;
const PARTICLE_SIZE_MAX = 0.56;

const GLYPH: Record<Direction, string> = { up: "↑", down: "↓", left: "←", right: "→" };

const ARROW_COLOR = "#ffcf6b";

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly visuals = new Map<number, Visual>();
  private particles: Particle[] = [];
  private cssSize = 0;
  private dpr = 1;
  private raf = 0;
  private lastTs = 0;
  /** 关闭后所有过渡瞬时完成 */
  animations = true;
  /** 决策方向粒子动效 */
  particlesEnabled = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("无法获取 2D 绘图上下文");
    this.ctx = ctx;
  }

  resize(cssSize: number): void {
    if (cssSize <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (cssSize === this.cssSize && dpr === this.dpr) return;

    this.cssSize = cssSize;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.canvas.style.width = `${cssSize}px`;
    this.canvas.style.height = `${cssSize}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /* ---------- 几何：等距由构造保证 ---------- */

  private get pad(): number {
    return this.cssSize * 0.028;
  }

  private get gap(): number {
    return this.pad * (SIZE <= 4 ? 0.62 : 0.5);
  }

  private get cell(): number {
    return (this.cssSize - this.pad * 2 - this.gap * (SIZE - 1)) / SIZE;
  }

  /** 格坐标 → 像素坐标（格子左上角）。入参应为整数格索引。 */
  private px(gx: number, gy: number): { x: number; y: number } {
    const step = this.cell + this.gap;
    return { x: this.pad + gx * step, y: this.pad + gy * step };
  }

  /**
   * 连续格坐标 → 像素坐标。
   * 整数部分是格索引，小数部分是格内偏移（0.5 = 格心）。
   * 不能用 px() —— 那里 step 含 gap，会把小数部分放大。
   */
  private pxFrac(gx: number, gy: number): { x: number; y: number } {
    const step = this.cell + this.gap;
    const fx = Math.floor(gx);
    const fy = Math.floor(gy);
    return {
      x: this.pad + fx * step + (gx - fx) * this.cell,
      y: this.pad + fy * step + (gy - fy) * this.cell,
    };
  }

  /* ---------- 棋子状态同步 ---------- */

  sync(tiles: Tile[], justDied: Tile[] = []): void {
    const alive = new Set(tiles.map((t) => t.id));

    for (const t of tiles) {
      const v = this.visuals.get(t.id);
      if (!v) {
        const spawn = Boolean(t.isNew);
        this.visuals.set(t.id, {
          value: t.value,
          x: t.col,
          y: t.row,
          scale: this.animations ? (spawn ? 0.55 : 1.14) : 1,
          alpha: this.animations && spawn ? 0 : 1,
          tx: t.col,
          ty: t.row,
          tScale: 1,
          tAlpha: 1,
          dying: false,
        });
      } else {
        v.value = t.value;
        v.tx = t.col;
        v.ty = t.row;
        v.tScale = 1;
        v.tAlpha = 1;
        v.dying = false;
      }
    }

    for (const t of justDied) {
      const v = this.visuals.get(t.id);
      if (!v) continue;
      v.tx = t.col;
      v.ty = t.row;
      v.dying = true;
      v.tAlpha = 0;
      v.tScale = 0.86;
    }

    for (const [id, v] of this.visuals) {
      if (!alive.has(id) && !v.dying) {
        v.dying = true;
        v.tAlpha = 0;
      }
    }

    if (!this.animations) {
      for (const [id, v] of this.visuals) {
        if (v.dying) {
          this.visuals.delete(id);
          continue;
        }
        v.x = v.tx;
        v.y = v.ty;
        v.scale = 1;
        v.alpha = 1;
      }
      this.cancel();
      this.draw();
      return;
    }

    for (const [id, v] of this.visuals) {
      if (v.dying && v.alpha < 0.02) this.visuals.delete(id);
    }

    this.start();
  }

  /* ---------- 决策方向粒子 ---------- */

  /**
   * 在「本手发生变化的格子」附近撒箭头粒子。
   *
   * @param dir    本手的移动方向，粒子沿它飘散
   * @param cells  本手发生变化的格子（行、列）。只在这些位置生成，
   *               未参与的格子保持干净 —— 粒子因此读起来像「瓷砖划过的轨迹」。
   */
  burst(dir: Direction, cells: Array<{ row: number; col: number }>): void {
    if (!this.animations || !this.particlesEnabled || this.cssSize <= 0) return;
    if (cells.length === 0) return;

    const vertical = dir === "up" || dir === "down";
    const positive = dir === "down" || dir === "right"; // 朝坐标轴正方向
    const speed = positive ? 1.6 : -1.6;

    for (const cell of cells) {
      const count =
        PARTICLE_PER_CELL_MIN +
        Math.floor(Math.random() * (PARTICLE_PER_CELL_MAX - PARTICLE_PER_CELL_MIN + 1));

      for (let i = 0; i < count; i++) {
        // 起点在格心附近抖动，范围约 ±0.3 格
        const jx = (Math.random() - 0.5) * 0.6;
        const jy = (Math.random() - 0.5) * 0.6;

        this.particles.push({
          x: cell.col + 0.5 + jx,
          y: cell.row + 0.5 + jy,
          vx: vertical ? 0 : speed * (0.7 + Math.random() * 0.6),
          vy: vertical ? speed * (0.7 + Math.random() * 0.6) : 0,
          size: PARTICLE_SIZE_MIN + Math.random() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN),
          age: 0,
          ttl: PARTICLE_TTL * (0.7 + Math.random() * 0.65),
          glyph: GLYPH[dir],
        });
      }
    }

    this.start();
  }

  clear(): void {
    this.cancel();
    this.visuals.clear();
    this.particles = [];
    this.draw();
  }

  private cancel(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.lastTs = 0;
  }

  /* ---------- 动画循环 ---------- */

  private start(): void {
    if (this.raf) return;
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (ts: number): void => {
    const rawDt = this.lastTs ? Math.min(ts - this.lastTs, 60) : 16.667;
    const dt = rawDt / 16.667;          // 以「帧」为单位的归一化步长
    const dtSec = rawDt / 1000;
    this.lastTs = ts;
    const k = 1 - Math.pow(1 - EASE, dt);

    let busy = false;

    for (const [id, v] of this.visuals) {
      v.x += (v.tx - v.x) * k;
      v.y += (v.ty - v.y) * k;
      v.scale += (v.tScale - v.scale) * k;
      v.alpha += (v.tAlpha - v.alpha) * k;

      if (
        Math.abs(v.tx - v.x) > 0.002 ||
        Math.abs(v.ty - v.y) > 0.002 ||
        Math.abs(v.tScale - v.scale) > 0.004 ||
        Math.abs(v.tAlpha - v.alpha) > 0.01
      ) {
        busy = true;
      }
      if (v.dying && v.alpha < 0.02) this.visuals.delete(id);
    }

    if (this.particles.length) {
      busy = true;
      for (const p of this.particles) {
        p.age += dtSec;
        p.x += p.vx * dtSec;
        p.y += p.vy * dtSec;
      }
      this.particles = this.particles.filter((p) => p.age < p.ttl);
    }

    this.draw();

    if (busy) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.raf = 0;
      this.draw();
    }
  };

  /* ---------- 绘制 ---------- */

  private draw(): void {
    const ctx = this.ctx;
    const S = this.cssSize;
    if (S <= 0) return;

    ctx.clearRect(0, 0, S, S);

    const n = SIZE;
    const c = this.cell;
    const r = c * 0.15;

    // 棋盘底板
    ctx.fillStyle = "#141210";
    roundRect(ctx, 0, 0, S, S, S * 0.032);
    ctx.fill();

    // 空格子：更暗的井 + 极淡描边
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const { x, y } = this.px(col, row);
        ctx.fillStyle = "#0d0c0a";
        roundRect(ctx, x, y, c, c, r);
        ctx.fill();
        if (c > 26) {
          ctx.strokeStyle = "rgba(255,255,255,.05)";
          ctx.lineWidth = 1;
          roundRect(ctx, x + 0.5, y + 0.5, c - 1, c - 1, r);
          ctx.stroke();
        }
      }
    }

    // 棋子
    for (const v of this.visuals.values()) {
      if (v.alpha < 0.02) continue;
      const s = swatch(v.value);
      const { x, y } = this.px(v.x, v.y);
      const cx = x + c / 2;
      const cy = y + c / 2;
      const w = c * v.scale;

      ctx.save();
      ctx.globalAlpha = Math.min(1, v.alpha);
      if (s.glow) {
        ctx.shadowColor = s.bg;
        ctx.shadowBlur = c * 0.4;
      }
      ctx.fillStyle = s.bg;
      roundRect(ctx, cx - w / 2, cy - w / 2, w, w, r * v.scale);
      ctx.fill();
      ctx.restore();

      if (v.alpha > 0.25) {
        const digits = String(v.value).length;
        const ratio = digits <= 2 ? 0.42 : digits === 3 ? 0.32 : 0.24;
        const fs = Math.max(8, c * ratio * v.scale);
        ctx.save();
        ctx.globalAlpha = Math.min(1, v.alpha);
        ctx.fillStyle = s.fg;
        ctx.font = `600 ${fs.toFixed(1)}px ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(v.value), cx, cy + fs * 0.03);
        ctx.restore();
      }
    }

    // 方向粒子（画在棋子上方，带辉光）
    if (this.particles.length) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = ARROW_COLOR;

      for (const p of this.particles) {
        const t = p.age / p.ttl;                    // 0 → 1
        // 透明度与字号都随进度衰减；字号用更小的指数使收缩更「快」
        const alpha = Math.pow(1 - t, 1.6);
        const shrink = Math.pow(1 - t, 0.75);
        // ★ 字号锚定格子边长，而非棋盘边长 —— 换尺寸时比例恒定
        const fs = Math.max(5, this.cell * p.size * shrink);
        const { x, y } = this.pxFrac(p.x, p.y);

        ctx.globalAlpha = alpha * 0.95;
        ctx.shadowBlur = fs * 0.8;
        ctx.fillStyle = ARROW_COLOR;
        ctx.font = `700 ${fs.toFixed(1)}px ui-monospace, "Geist Mono", monospace`;
        ctx.fillText(p.glyph, x, y);
      }
      ctx.restore();
    }
  }
}
