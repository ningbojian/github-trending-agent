import { BASE_STYLES } from '../ui/styles.js';
import { APP_CARD_BG, APP_CARD_BORDER, APP_PAGE_BG } from '../ui/tokens.js';

/**
 * 面板样式 = 全站共享层 + 面板专属增量。
 *
 * 深墨玻璃主题已经在 src/ui/styles.ts 里成为全站默认；这里只保留
 * 面板独有的东西：导航、总览主卡、口味行、角落机器人，以及更紧的间距。
 * api/panel.ts 的类名不用改。
 */

const PANEL_STYLES_DELTA = `
.panel{font-size:15px;line-height:1.6;color:var(--p-text);}

/* 面板信息密度更高：卡片、列表、表单、按钮统一收一档。 */
.panel .p-card{padding:12px;margin:0 0 10px;}
/* 密度规则的 margin 简写会盖掉基类的 .p-card:last-child，这里补回来。 */
.panel .p-card:last-child{margin-bottom:0;}
.panel .p-card-title{margin:0 0 6px;}
.p-chips{margin-top:8px;gap:4px;}
.p-chip{padding:2px 7px;font-size:11px;}
.p-actions{margin-top:8px;gap:8px;align-items:center;}
.p-actions form{display:flex;}
.p-actions .p-btn{height:40px;min-height:40px;min-width:88px;padding:0 14px;
  font-size:14px;line-height:1;border-width:1px;border-style:solid;}
.p-actions .p-btn.ghost{border-color:rgba(255,255,255,.14);}
.panel .p-btn{height:40px;min-height:40px;padding:0 14px;font-size:14px;line-height:1;}
.panel .p-btn.block{width:100%;}
.panel .p-btn.danger{height:auto;min-height:32px;padding:4px 8px;font-size:13px;}
.panel .p-btn.sm{height:34px;min-height:34px;padding:0 10px;font-size:12px;}
.p-stats{margin:0 0 8px;}
.p-stat{padding:8px 6px;}
.p-stat strong{font-size:19px;}
.p-grid{gap:8px;margin:0 0 10px;}
.p-tile{padding:11px;}
.p-tile-num{font-size:20px;}
.p-row{padding:8px 0;}
.p-empty{padding:12px 10px;}
.p-banner{padding:8px 10px;margin:0 0 10px;}
.p-field{margin:0 0 10px;}
.p-label{margin:0 0 4px;}
.p-input,.p-select{padding:9px 10px;min-height:40px;}
.p-hint{margin-top:4px;}
.p-foot{margin-top:10px;}

/* 导航：横向可滚动的分段控件，当前页用浮起卡片。 */
.panel-nav{display:flex;gap:3px;padding:3px;margin:0 0 12px;background:var(--p-soft);
  border:1px solid var(--p-line);border-radius:12px;overflow-x:auto;scrollbar-width:none;
  -webkit-overflow-scrolling:touch;}
.panel-nav::-webkit-scrollbar{display:none;}
.panel-nav a{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  min-height:38px;padding:6px 11px;border-radius:9px;font-size:13px;
  color:var(--p-muted);text-decoration:none;font-weight:500;white-space:nowrap;}
.panel-nav a[aria-current="page"]{background:var(--p-card);color:var(--p-text);
  font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.25);}

/* 视图头：标题 + 一句状态 + 角落机器人。除总览外每个视图都用它。 */
.p-view-head{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:0 0 10px;}
.p-view-head-main{flex:1;min-width:0;}
.p-view-say{display:inline-block;max-width:100%;margin-top:5px;padding:3px 8px;
  border-radius:8px;background:var(--p-card);border:1px solid var(--p-line);
  font-size:12px;line-height:1.5;color:var(--p-text);}
.p-view-head .p-mascot{flex:0 0 auto;width:54px;height:64px;}

/* 总览主卡：状态、节奏、动作一次看完。 */
.p-hero-card{position:relative;}
/* 右侧给角落机器人留位；必须带 .panel 前缀，否则被 .panel .p-card 的 padding 简写盖掉。 */
.panel .p-hero-card{padding-right:76px;}
.p-hero-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
/* 设置页的状态块仍用 p-hero-top / p-hero-label。 */
.p-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
.p-hero-label{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--p-muted);
  text-transform:uppercase;}
.p-hero-time{font-size:21px;font-weight:700;line-height:1.2;margin:0;
  letter-spacing:-.01em;}
.p-hero-time.sm{font-size:16px;}
.p-hero-sub{font-size:12px;color:var(--p-muted);margin-top:2px;}

/* 本周个人卡的口味行。 */
.p-taste{font-size:13px;color:var(--p-muted);}
.p-taste b{color:var(--p-text);font-weight:600;}

/* 角落机器人：hero 右上角的 SVG 软球 + 两颗环绕贴纸。 */
.p-hero-card .p-mascot{position:absolute;top:8px;right:8px;}
.p-mascot{position:relative;width:64px;height:76px;perspective:800px;
  touch-action:none;cursor:grab;user-select:none;}
.p-mascot.grabbing{cursor:grabbing;}
.p-mascot .p-robot-svg{display:block;width:100%;height:100%;transform-style:preserve-3d;
  transition:transform .2s ease-out;}
.p-orb{position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;
  border-radius:50%;display:flex;align-items:center;justify-content:center;
  border:1px solid rgba(255,255,255,.18);
  background:radial-gradient(circle at 34% 28%, rgba(96,138,198,.6), rgba(13,19,30,.96) 62%, rgba(7,11,18,.98));
  box-shadow:0 0 14px rgba(34,211,238,.22),0 4px 10px rgba(2,6,23,.35),
    inset 0 1px 0 rgba(255,255,255,.22);
  cursor:grab;touch-action:none;will-change:transform;z-index:3;}
.p-orb.grabbing{cursor:grabbing;}
.p-orb img{width:12px;height:12px;pointer-events:none;
  filter:drop-shadow(0 0 1px rgba(255,255,255,.8)) drop-shadow(0 1px 2px rgba(0,0,0,.45));}
.p-orb::before{content:"";position:absolute;inset:2px;border-radius:50%;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,0) 48%);}
.p-orb::after{content:"";position:absolute;top:1px;right:2px;width:3.5px;height:3.5px;
  background:#ffffff;opacity:.9;pointer-events:none;
  clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%);}
@media (prefers-reduced-motion:reduce){
  .p-mascot .p-robot-svg{transition:none;}
}
@media (max-width:420px){
  .panel .p-hero-card{padding-right:70px;}
  .p-mascot{width:58px;height:70px;}
  /* 窄屏放不下 6 个横排条目：改成 3×2，全部可见，不用横向滑动。 */
  .panel-nav{display:grid;grid-template-columns:repeat(3,1fr);overflow:visible;}
  .panel-nav a{text-align:center;}
}
@media (max-width:380px){
  .p-hero-time{font-size:21px;}
}
`;

export const PANEL_STYLES = BASE_STYLES + PANEL_STYLES_DELTA;

/** 面板与全站网页共用深墨夜景 + 蓝/青光源。 */
export const PANEL_PAGE_BG = APP_PAGE_BG;

/** 主卡片：深墨半透明。 */
export const PANEL_CARD_BG = APP_CARD_BG;

/** 主卡片边框：白色半透明。 */
export const PANEL_CARD_BORDER = APP_CARD_BORDER;
