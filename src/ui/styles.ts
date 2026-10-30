import { cssVars, UI } from './tokens.js';

/**
 * 全站共享样式表。所有服务端渲染页面（面板、join、set-key、邮箱设置、
 * metrics、trace、OAuth 回执）都通过 renderAppPage 注入它。
 *
 * 主题：深墨玻璃。与面板同一套配色和质感——深色页壳、半透明卡片、
 * 青色强调、内高光与指针柔光。邮件模板不走这里，仍是浅色。
 *
 * 命名口径：`.p-*` 是 page primitives，不是「panel」。面板专属的
 * `.panel-*` / `.p-hero-*` / `.p-taste` / `.p-mascot` 留在 src/panel/styles.ts 的增量里。
 *
 * 约束：只使用 CSS 变量、grid、flex、env() 和传统媒体查询；
 * 不用 :has / color-mix / 容器查询，避免微信 WebView 版本差异。
 */
export const BASE_STYLES = `${cssVars()}
/* 统一盒模型：min-height/padding/border 一起算进高度。
   否则 min-height:44px 还要再加 padding 与边框，按钮会虚高到 66px。 */
*,*::before,*::after{box-sizing:border-box;}
.p-card{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.12);
  border-radius:var(--p-radius);padding:16px;margin:0 0 14px;position:relative;overflow:hidden;
  backdrop-filter:blur(26px) saturate(160%);-webkit-backdrop-filter:blur(26px) saturate(160%);
  box-shadow:0 14px 34px -22px rgba(2,6,23,.75),inset 0 1px 0 rgba(255,255,255,.12);}
.p-card:last-child{margin-bottom:0;}
/* 指针柔光：--mx / --my 由 src/ui/pointer.ts 写入；无脚本时只是一块静态玻璃。 */
.p-card::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  z-index:0;opacity:0;transition:opacity .35s ease-out;
  background:radial-gradient(220px circle at var(--mx,50%) var(--my,0%),
    rgba(255,255,255,.07), transparent 60%);}
.p-card > *{position:relative;z-index:1;}
.p-card.recommended{border-left:4px solid var(--p-accent);}
.p-card-title{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--p-muted);
  margin:0 0 10px;}
.p-card-head{display:flex;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:wrap;}
.p-card-head .p-section-title{margin:0;}
.p-note{border-top:1px dashed var(--p-line);padding-top:12px;margin-top:14px;
  font-size:13px;color:var(--p-muted);}
.p-section-title{font-size:15px;font-weight:600;margin:16px 0 8px;}
.p-lead{font-size:15px;line-height:1.7;color:var(--p-text);margin:0 0 16px;}
.p-meta{font-size:12px;color:var(--p-muted);}
.p-hint{display:block;font-size:12px;color:var(--p-muted);margin-top:6px;}
.p-prose{white-space:pre-wrap;font-size:14px;line-height:1.8;margin:0 0 14px;}
.p-date{font-size:15px;font-weight:700;margin:0 0 8px;}

/* 状态徽章与提示条。 */
.p-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;
  border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;}
.p-badge::before{content:"";width:6px;height:6px;border-radius:50%;
  background:currentColor;}
.p-badge.ok{color:var(--p-ok);background:var(--p-ok-bg);}
.p-badge.off{color:var(--p-muted);background:var(--p-divider);}
.p-badge.accent{color:var(--p-accent-ink);background:var(--p-accent-soft);}

.p-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;}
.p-chip{padding:3px 9px;border-radius:999px;background:var(--p-accent-soft);
  color:var(--p-accent-ink);font-size:12px;font-weight:500;}

.p-banner{padding:10px 12px;border-radius:10px;font-size:14px;margin:0 0 12px;
  line-height:1.6;}
.p-banner.ok{background:var(--p-ok-bg);color:var(--p-ok);}
.p-banner.err{background:var(--p-danger-bg);color:var(--p-danger);}
.p-banner.warn{background:var(--p-warn-bg);color:var(--p-warn);}
.p-banner.info{background:var(--p-accent-soft);color:var(--p-accent-ink);}

/* 键值行。 */
.p-kv{margin:0;}
.p-kv div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;
  border-top:1px solid var(--p-divider);font-size:14px;}
.p-kv div:first-child{border-top:0;padding-top:0;}
.p-kv dt{color:var(--p-muted);}
.p-kv dd{margin:0;font-weight:600;text-align:right;word-break:break-all;}

/* 数字卡：面板的本周、metrics 的瓦片共用。 */
.p-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 10px;}
.p-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
  gap:8px;margin:0 0 16px;}
.p-stat{background:var(--p-card);border:1px solid var(--p-line);border-radius:10px;
  padding:10px 8px;text-align:center;}
.p-stat strong{display:block;font-size:22px;line-height:1.1;color:var(--p-accent);
  font-variant-numeric:tabular-nums;}
.p-stat span{display:block;font-size:12px;color:var(--p-muted);margin-top:3px;}

/* 瓦片入口。 */
.p-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.p-tile{display:block;padding:14px;background:var(--p-card);border:1px solid var(--p-line);
  border-radius:12px;text-decoration:none;color:inherit;min-height:${UI.touch}px;
  transition:border-color .15s ease,opacity .15s ease;}
.p-tile:active{border-color:var(--p-accent);}
.p-tile-num{font-size:24px;font-weight:700;color:var(--p-accent);line-height:1.15;}
.p-tile-label{font-size:14px;font-weight:600;margin-top:2px;}
.p-tile-hint{font-size:12px;color:var(--p-muted);}

/* 列表行。 */
.p-list{list-style:none;padding:0;margin:0;}
.p-row{display:flex;align-items:center;gap:10px;padding:11px 0;
  border-top:1px solid var(--p-divider);font-size:14px;}
.p-row:first-child{border-top:0;padding-top:0;}
.p-row-main{flex:1;min-width:0;}
.p-row-main a{color:var(--p-text);text-decoration:none;font-weight:600;
  word-break:break-all;}
.p-row-link{display:block;color:var(--p-text);text-decoration:none;
  -webkit-tap-highlight-color:transparent;min-height:${UI.touch}px;
  transition:opacity .15s ease;}
.p-row-link:active{opacity:.65;}
.p-row-title{display:block;font-weight:600;word-break:break-all;}
.p-row-sub{display:block;color:var(--p-muted);font-size:12px;}
.p-row-num{flex:0 0 24px;color:var(--p-muted);font-size:13px;
  font-variant-numeric:tabular-nums;}
.p-row-arrow{color:var(--p-muted);font-size:16px;line-height:1;}

/* 表单。 */
.p-field{display:block;margin:0 0 12px;}
.p-field:last-child{margin-bottom:0;}
.p-label{display:block;font-size:13px;font-weight:600;color:var(--p-muted);
  margin:0 0 6px;}
.p-input,.p-select{width:100%;box-sizing:border-box;padding:11px 12px;font-size:16px;
  min-height:${UI.touch}px;border:1px solid var(--p-field-line);border-radius:10px;
  background:var(--p-soft);color:var(--p-text);outline:none;
  -webkit-appearance:none;font-family:inherit;}
.p-input::placeholder{color:var(--p-placeholder);}
.p-select option{background:#151922;color:#ffffff;}
.p-input:focus,.p-select:focus{border-color:var(--p-accent);
  box-shadow:0 0 0 3px rgba(34,211,238,.18);}
.p-checks{display:flex;flex-wrap:wrap;gap:4px 16px;}
.p-check{display:inline-flex;align-items:center;gap:6px;font-size:14px;
  min-height:${UI.touch}px;}
.p-check input{width:18px;height:18px;accent-color:var(--p-accent);}
.p-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}

/* 按钮。 */
.p-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  min-height:${UI.touch}px;padding:10px 16px;border-radius:10px;
  border:1px solid rgba(34,211,238,.35);
  background:var(--p-accent-soft);color:var(--p-accent-ink);
  font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;
  -webkit-appearance:none;font-family:inherit;
  box-shadow:inset 0 1px 0 rgba(165,243,252,.25),0 6px 18px rgba(34,211,238,.10);
  transition:background-color .15s ease,border-color .15s ease,opacity .15s ease,filter .15s ease;}
.p-btn.block{width:100%;}
.p-btn.ghost{background:rgba(255,255,255,.06);color:var(--p-text);
  border-color:var(--p-line);box-shadow:none;}
.p-btn.danger{background:none;color:var(--p-danger);border:0;padding:6px 8px;
  font-size:13px;font-weight:500;box-shadow:none;}
.p-btn.sm{padding:7px 12px;font-size:13px;border-radius:9px;}
.p-btn.off{background:var(--p-divider);color:var(--p-muted);border-color:transparent;
  box-shadow:none;cursor:default;}

/* 空态。 */
.p-empty{padding:18px 12px;text-align:center;color:var(--p-muted);font-size:14px;
  border:1px dashed var(--p-line);border-radius:12px;background:var(--p-soft);}

/* 历史/条目。 */
.p-item{display:flex;gap:10px;padding:9px 0;border-top:1px solid var(--p-divider);
  font-size:14px;line-height:1.55;}
.p-item:first-child{border-top:0;}
.p-item-rank{flex:0 0 22px;color:var(--p-muted);font-variant-numeric:tabular-nums;}
.p-item-body{flex:1;min-width:0;}
.p-item-name{font-weight:600;word-break:break-all;color:var(--p-accent);}
.p-item-meta{color:var(--p-muted);font-size:12px;}
.p-item-summary{color:var(--p-text);font-size:13px;margin-top:2px;}

/* 数据表：只在卡片内部横向滚动，不撑破页面。 */
.p-table-wrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;
  scrollbar-width:thin;margin:0 0 16px;}
.p-table{width:100%;border-collapse:collapse;font-size:13px;}
.p-table th{text-align:left;padding:4px 10px 4px 0;color:var(--p-muted);
  font-weight:600;}
.p-table td{padding:3px 10px 3px 0;white-space:nowrap;}
.p-table td.wrap{white-space:normal;word-break:break-all;color:var(--p-muted);}
.p-table td.num{text-align:right;color:var(--p-muted);white-space:nowrap;}
.p-table td.muted{color:var(--p-muted);}

/* 原生折叠面板：trace 每条记录。 */
.p-disclosure{border:1px solid var(--p-line);border-radius:10px;padding:0 10px;
  margin:0 0 8px;background:var(--p-soft);}
.p-disclosure summary{cursor:pointer;font-size:13px;line-height:1.7;
  min-height:${UI.touch}px;padding:8px 0;}
.p-disclosure[open]{padding-bottom:10px;}

/* join 页的二维码与步骤。 */
.p-qr-grid{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 10px;}
.p-qr{text-align:center;}
.p-qr img{display:block;width:132px;height:132px;border:1px solid var(--p-line);
  border-radius:8px;background:var(--p-card);}
.p-qr-caption{font-size:12px;color:var(--p-muted);margin-top:6px;}
.p-steps{list-style:none;padding:0;margin:0 0 12px;font-size:14px;line-height:1.6;}
.p-step{display:flex;gap:8px;margin:6px 0;}
.p-step-num{flex:0 0 20px;height:20px;line-height:20px;text-align:center;
  border-radius:50%;background:var(--p-accent-soft);color:var(--p-accent-ink);
  font-size:12px;font-weight:700;}

/* 品牌头图标：SVG 自带 40px 宽高属性，容器缩到 28px 时按容器缩放。 */
.p-header-icon svg{display:block;width:100%;height:100%;}

/* 页面外壳：深色头 + 内容卡共用一个圆角容器，桌面上浮起。 */
.app-shell,.panel-shell{background:rgba(12,16,22,.55);
  backdrop-filter:blur(30px) saturate(160%);-webkit-backdrop-filter:blur(30px) saturate(160%);
  box-shadow:0 30px 70px -42px rgba(0,0,0,.7),0 2px 10px rgba(0,0,0,.18);}

/* 状态文字。 */
.p-status.ok{color:var(--p-ok);font-weight:700;}
.p-status.err{color:var(--p-danger);font-weight:700;}

/* 排版工具类。 */
.p-mt{margin-top:10px;}
.p-mb{margin-bottom:10px;}
.p-break{word-break:break-all;}
.p-break a{color:var(--p-accent);}
.p-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}
.p-foot{font-size:12px;color:var(--p-muted);text-align:center;margin:14px 0 0;}
.p-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
  overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}

/* 交互状态：hover 只在真有指针的设备上生效，避免手机粘滞。 */
.p-btn:focus-visible,.p-tile:focus-visible,.p-row-link:focus-visible,
.p-disclosure summary:focus-visible{outline:3px solid var(--p-accent);
  outline-offset:2px;}
@media (hover:hover){
  .p-btn:hover{filter:brightness(1.12);}
  .p-btn.ghost:hover{border-color:var(--p-accent);}
  .p-tile:hover{border-color:var(--p-accent);}
  .p-row-link:hover .p-row-title{color:var(--p-accent);}
  .p-card:hover::after{opacity:1;}
}
@media (prefers-reduced-motion:reduce){
  .p-btn,.p-tile,.p-row-link,.p-card::after{transition:none;}
}

@media (max-width:420px){
  /* 两张码并排要 132×2+12=276px，而 390px 手机上卡片内宽只有 274px——差 2px 会掉行。 */
  .p-qr img{width:124px;height:124px;}
}

@media (max-width:380px){
  .p-grid{grid-template-columns:1fr;}
  .p-stats{grid-template-columns:repeat(3,1fr);}
}
`;
