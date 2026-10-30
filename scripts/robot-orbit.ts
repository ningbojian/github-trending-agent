import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 素材版：Twemoji 贴纸。
 *
 * 不再手画配饰；用 Twemoji 官方 SVG（CC-BY 4.0）做球身上的贴纸：
 * - 每天一颗日贴纸（帽子/耳机/围巾/工牌/外套/墨镜/咖啡）；
 * - 天气另有一颗贴纸（太阳/雨/雪/火），不往球上硬穿衣服；
 * - 白底圆贴纸 + 软阴影，跟着软球一起捏。
 *
 * 用法：npx tsx scripts/robot-stickers.ts
 */

const assetDir = new URL('../docs/assets/emoji/', import.meta.url);
function asset(code: string): string {
  return (
    'data:image/svg+xml;base64,' +
    readFileSync(new URL(`${code}.svg`, assetDir)).toString('base64')
  );
}

const ASSETS: Record<string, string> = {
  cap: asset('1f9e2'),
  headphones: asset('1f3a7'),
  scarf: asset('1f9e3'),
  sunglasses: asset('1f576'),
  badge: asset('1f194'),
  bulb: asset('1f4a1'),
  coat: asset('1f9e5'),
  coffee: asset('2615'),
  sun: asset('2600'),
  rain: asset('1f327'),
  snow: asset('2744'),
  fire: asset('1f525')
};
const assetsJson = JSON.stringify(ASSETS);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>你的小机器人 · 环绕贴纸版</title>
<style>
:root{
  --ink:#101318;
  --accent:#22D3EE;
  --accent-soft:#A5F3FC;
  --text:#ffffff;
  --text-2:rgba(255,255,255,.72);
  --text-3:rgba(255,255,255,.42);
  --line:rgba(255,255,255,.15);
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;
  --mono:"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --spring:cubic-bezier(0.16,1,0.3,1);
}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--ink);color:var(--text);font-family:var(--sans);
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
.scene{position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden;background:var(--ink);}
.well-core{position:absolute;border-radius:50%;}
.well-a .well-core{width:760px;height:760px;top:-240px;right:-200px;
  background:radial-gradient(circle,rgba(154,167,184,.20),transparent 65%);}
.well-b .well-core{width:700px;height:700px;bottom:-280px;left:-220px;
  background:radial-gradient(circle,rgba(59,130,246,.16),transparent 65%);}
.well-c .well-core{width:520px;height:520px;top:32%;left:40%;
  background:radial-gradient(circle,rgba(34,211,238,.09),transparent 62%);}
.grain{position:fixed;inset:0;z-index:9;pointer-events:none;opacity:.032;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
.stage{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:36px 20px 52px;
  display:flex;flex-direction:column;align-items:center;min-height:100vh;}
.head-copy{text-align:center;margin-bottom:4px;}
.head-copy h1{font-size:32px;line-height:1.15;font-weight:600;letter-spacing:-.02em;margin:0 0 10px;}
.head-copy p{color:var(--text-2);font-size:13px;line-height:1.7;margin:0;}
.viewport{position:relative;width:min(560px,92vw);height:480px;margin:2px auto 0;
  perspective:900px;touch-action:none;cursor:grab;user-select:none;}
.viewport.grabbing{cursor:grabbing;}
#blobSvg{display:block;width:100%;height:100%;transform-style:preserve-3d;
  transform:rotateX(0deg) rotateY(0deg);transition:transform .2s ease-out;}
.bubble{position:absolute;top:18px;right:14px;max-width:210px;padding:10px 14px;
  border:1px solid rgba(34,211,238,.35);border-radius:16px;
  background:rgba(16,19,24,.82);
  backdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);
  color:var(--accent-soft);font-size:12px;line-height:1.6;opacity:0;
  transform:translateY(8px);pointer-events:none;
  transition:opacity .5s var(--spring),transform .5s var(--spring);}
.bubble.show{opacity:1;transform:translateY(0);}
.zzz{position:absolute;top:36px;left:18px;font-family:var(--mono);font-size:16px;
  color:var(--accent-soft);opacity:0;transition:opacity .4s var(--spring);}
.orb{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;
  border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(circle at 34% 28%, #ffffff, #eaf3ff 52%, #c9dcf6);
  box-shadow:0 0 26px rgba(120,190,255,.35),0 10px 24px rgba(2,6,23,.28),
    inset 0 -4px 8px rgba(11,18,32,.08);
  cursor:grab;touch-action:none;will-change:transform;z-index:3;}
.orb.grabbing{cursor:grabbing;}
.orb img{width:34px;height:34px;pointer-events:none;}
.orb::before{content:"";position:absolute;inset:5px;border-radius:50%;
  background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,0) 48%);
  pointer-events:none;}
.orb::after{content:"";position:absolute;top:2px;right:4px;width:10px;height:10px;
  background:#ffffff;opacity:.9;pointer-events:none;
  clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%);}
.controls{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:2px;}
.controls button{font:inherit;font-size:13px;padding:9px 14px;border-radius:16px;
  border:1px solid var(--line);background:rgba(255,255,255,.06);color:rgba(255,255,255,.86);
  cursor:pointer;transition:transform .5s var(--spring),background-color .5s var(--spring),
    border-color .5s var(--spring);}
.controls button:hover{transform:translateY(-2px);background:rgba(255,255,255,.10);
  border-color:rgba(255,255,255,.30);}
.controls button:active{transform:scale(.97);}
.controls button[data-state="happy"]{border-color:rgba(34,211,238,.35);
  background:rgba(34,211,238,.12);color:var(--accent-soft);}
.outfit-controls{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:8px;}
.outfit-controls button{font:inherit;font-size:12px;padding:7px 11px;border-radius:14px;
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);
  color:rgba(255,255,255,.72);cursor:pointer;
  transition:background-color .2s ease-out,border-color .2s ease-out,color .2s ease-out;}
.outfit-controls button:hover{border-color:rgba(255,255,255,.25);color:var(--text);}
.outfit-controls button.active{background:rgba(34,211,238,.12);
  border-color:rgba(34,211,238,.35);color:var(--accent-soft);}
.outfit-line{color:var(--text-2);font-size:12px;text-align:center;margin:10px 0 0;}
.hint{color:var(--text-3);font-size:12px;text-align:center;margin-top:14px;}
.hint kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--line);
  border-radius:6px;padding:1px 5px;color:var(--text-2);}
@media (max-width:720px){
  .stage{padding:26px 14px 38px;}
  .head-copy h1{font-size:26px;}
  .viewport{height:400px;}
  .bubble{right:50%;transform:translate(50%,8px);}
  .bubble.show{transform:translate(50%,0);}
}
@media (prefers-reduced-motion:reduce){
  #blobSvg,.bubble,.controls button{transition:none;}
}
</style>
</head>
<body>
<div class="scene">
  <div class="well well-a"><div class="well-core"></div></div>
  <div class="well well-b"><div class="well-core"></div></div>
  <div class="well well-c"><div class="well-core"></div></div>
</div>
<div class="grain"></div>

<main class="stage">
  <div class="head-copy">
    <h1>你的小机器人</h1>
    <p>日贴纸和天气变成两颗环绕它的小球星星；拖得动，松手会回到轨道。</p>
  </div>

  <div class="viewport" id="viewport">
    <svg id="blobSvg" viewBox="0 0 420 420" role="img" aria-label="捏捏机器人">
      <defs>
        <radialGradient id="blobFill" cx="35%" cy="28%" r="78%">
          <stop offset="0%" stop-color="#9dbdff"/>
          <stop offset="42%" stop-color="#3b82f6"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </radialGradient>
        <radialGradient id="blobHi" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity=".65"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="bobbleFill" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#a5f3fc"/>
          <stop offset="100%" stop-color="#22d3ee"/>
        </radialGradient>
        <filter id="softShadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#020617" flood-opacity=".45"/>
        </filter>
        <filter id="blurHi" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="14"/>
        </filter>
        <filter id="assetShadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#020617" flood-opacity=".32"/>
        </filter>
        <clipPath id="ballClip">
          <circle cx="0" cy="0" r="116"/>
        </clipPath>
        <linearGradient id="capGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#FBBF24"/>
          <stop offset="100%" stop-color="#D97706"/>
        </linearGradient>
        <linearGradient id="beanieGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#F87171"/>
          <stop offset="100%" stop-color="#B91C1C"/>
        </linearGradient>
        <linearGradient id="nightcapGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#818CF8"/>
          <stop offset="100%" stop-color="#4338CA"/>
        </linearGradient>
        <linearGradient id="scarfGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#EF4444"/>
          <stop offset="100%" stop-color="#B91C1C"/>
        </linearGradient>
        <linearGradient id="hoodGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1E40AF"/>
          <stop offset="100%" stop-color="#0F172A"/>
        </linearGradient>
        <linearGradient id="lensGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1F2937"/>
          <stop offset="100%" stop-color="#030712"/>
        </linearGradient>
        <linearGradient id="patchGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#FFFFFF"/>
          <stop offset="100%" stop-color="#DBEAFE"/>
        </linearGradient>
      </defs>
      <ellipse cx="210" cy="336" rx="106" ry="18" fill="#020617" opacity=".35" filter="url(#blurHi)"/>
      <circle id="blobStatic" cx="210" cy="205" r="116" fill="url(#blobFill)" filter="url(#softShadow)"/>
      <path id="blobPath" d="" fill="url(#blobFill)" filter="url(#softShadow)"/>
      <g id="hiGroup" transform="translate(210 205)">
        <ellipse cx="-48" cy="-54" rx="64" ry="44" fill="url(#blobHi)" filter="url(#blurHi)" opacity=".65"/>
      </g>
      <g id="face" transform="translate(210 205)">
        <g id="antenna">
          <ellipse cx="0" cy="-102" rx="16" ry="7" fill="#1e40af"/>
          <path d="M0 -100 L0 -138" stroke="#2563eb" stroke-width="12" stroke-linecap="round"/>
          <circle cx="0" cy="-154" r="20" fill="url(#bobbleFill)"/>
          <circle cx="-6" cy="-160" r="6" fill="#ffffff" opacity=".7"/>
        </g>
        <g id="eyesNormal">
          <ellipse cx="-46" cy="0" rx="23" ry="27" fill="#0B1220"/>
          <circle cx="-54" cy="-10" r="6" fill="#ffffff"/>
          <ellipse cx="46" cy="0" rx="23" ry="27" fill="#0B1220"/>
          <circle cx="38" cy="-10" r="6" fill="#ffffff"/>
        </g>
        <g id="eyesHappy" opacity="0">
          <path d="M-66 4 Q-46 -20 -26 4" stroke="#0B1220" stroke-width="6" fill="none" stroke-linecap="round"/>
          <path d="M26 4 Q46 -20 66 4" stroke="#0B1220" stroke-width="6" fill="none" stroke-linecap="round"/>
        </g>
        <g id="eyesSleep" opacity="0">
          <path d="M-66 0 Q-46 13 -26 0" stroke="#0B1220" stroke-width="6" fill="none" stroke-linecap="round"/>
          <path d="M26 0 Q46 13 66 0" stroke="#0B1220" stroke-width="6" fill="none" stroke-linecap="round"/>
        </g>
        <g id="eyesStar" opacity="0">
          <path d="M-46 -20 L-41 -6 L-27 -1 L-41 4 L-46 18 L-51 4 L-65 -1 L-51 -6 Z" fill="#A5F3FC"/>
          <path d="M46 -20 L51 -6 L65 -1 L51 4 L46 18 L41 4 L27 -1 L41 -6 Z" fill="#A5F3FC"/>
        </g>
        <g id="mouthHappy" opacity="0">
          <path d="M-14 46 Q-7 54 0 46 Q7 54 14 46" stroke="#0B1220" stroke-width="4" fill="none" stroke-linecap="round"/>
        </g>
        <g id="stickerWeather"></g>
        <g id="stickerDaily"></g>
      </g>
    </svg>
    <div class="bubble" id="bubble" role="status">捏我一下。</div>
    <div class="zzz" id="zzz">z z z</div>
    <div class="orb" id="dayOrb" role="img" aria-label="今天的贴纸">
      <img id="dayIcon" alt="">
    </div>
    <div class="orb" id="weatherOrb" role="img" aria-label="天气">
      <img id="weatherIcon" alt="">
    </div>
  </div>

  <div class="controls">
    <button data-state="idle">待机</button>
    <button data-state="happy">打招呼</button>
    <button data-state="sleep">睡觉</button>
    <button data-state="egg">彩蛋</button>
    <button data-state="reset">回正</button>
  </div>
  <div class="outfit-controls" id="dayControls">
    <button data-day="0">周一</button>
    <button data-day="1">周二</button>
    <button data-day="2">周三</button>
    <button data-day="3">周四</button>
    <button data-day="4">周五</button>
    <button data-day="5">周六</button>
    <button data-day="6">周日</button>
  </div>
  <div class="outfit-controls" id="weatherControls">
    <button data-weather="clear">晴 26°</button>
    <button data-weather="rain">雨 18°</button>
    <button data-weather="cold">冷 5°</button>
    <button data-weather="snow">雪 -2°</button>
    <button data-weather="hot">热 33°</button>
  </div>
  <p class="hint">拖动 = 捏 · 点击 = 打招呼 · 键盘输入 <kbd>g</kbd><kbd>h</kbd> 触发彩蛋 · Emoji artwork: Twemoji (CC-BY 4.0)</p>
</main>

<script>
(function () {
  var ASSETS = ${assetsJson};
  var svg = document.getElementById('blobSvg');
  var path = document.getElementById('blobPath');
  var staticCircle = document.getElementById('blobStatic');
  var face = document.getElementById('face');
  var hiGroup = document.getElementById('hiGroup');
  var eyesNormal = document.getElementById('eyesNormal');
  var eyesHappy = document.getElementById('eyesHappy');
  var eyesSleep = document.getElementById('eyesSleep');
  var eyesStar = document.getElementById('eyesStar');
  var mouthHappy = document.getElementById('mouthHappy');
  var stickerDaily = document.getElementById('stickerDaily');
  var stickerWeather = document.getElementById('stickerWeather');
  var dayIcon = document.getElementById('dayIcon');
  var weatherIcon = document.getElementById('weatherIcon');
  var dayOrb = document.getElementById('dayOrb');
  var weatherOrb = document.getElementById('weatherOrb');
  var dayControls = document.getElementById('dayControls');
  var weatherControls = document.getElementById('weatherControls');
  var bubble = document.getElementById('bubble');
  var zzz = document.getElementById('zzz');
  var viewport = document.getElementById('viewport');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var CX = 210;
  var CY = 205;
  var R = 116;
  var N = 14;
  var points = [];
  for (var i = 0; i < N; i += 1) {
    points.push({
      angle: (i / N) * Math.PI * 2,
      dx: 0, dy: 0, vx: 0, vy: 0, tx: 0, ty: 0
    });
  }

  var weekdays = [
    { label: '周一', name: '棒球帽', sticker: 'cap' },
    { label: '周二', name: '耳机', sticker: 'headphones' },
    { label: '周三', name: '围巾', sticker: 'scarf' },
    { label: '周四', name: '灯泡', sticker: 'bulb' },
    { label: '周五', name: '外套', sticker: 'coat' },
    { label: '周六', name: '墨镜', sticker: 'sunglasses' },
    { label: '周日', name: '咖啡', sticker: 'coffee' }
  ];
  var weathers = {
    clear: { temp: 26, cond: 'clear', text: '晴 26°C', badge: 'sun', emoji: '☀️' },
    rain: { temp: 18, cond: 'rain', text: '小雨 18°C', badge: 'rain', emoji: '🌧️' },
    cold: { temp: 5, cond: 'cloud', text: '阴冷 5°C', badge: 'snow', emoji: '❄️' },
    snow: { temp: -2, cond: 'snow', text: '小雪 -2°C', badge: 'snow', emoji: '❄️' },
    hot: { temp: 33, cond: 'clear', text: '晴热 33°C', badge: 'fire', emoji: '🔥' }
  };
  var outfitSvg = {
    cap: '<path d="M-112 -30 A 116 116 0 0 1 112 -30 Q 0 -64 -112 -30 Z" fill="url(#capGrad)"/>' +
      '<path d="M-118 -30 Q 0 -54 118 -30 L 118 -16 Q 0 -40 -118 -16 Z" fill="#D97706"/>' +
      '<path d="M-98 -44 Q 0 -124 98 -44" stroke="#FDE68A" stroke-width="4" opacity=".45" fill="none"/>',
    headphones: '<path d="M-110 0 A 116 116 0 0 1 110 0" stroke="#94A3B8" stroke-width="14" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="-108" cy="8" rx="18" ry="34" transform="rotate(-8 -108 8)" fill="#334155"/>' +
      '<ellipse cx="108" cy="8" rx="18" ry="34" transform="rotate(8 108 8)" fill="#334155"/>' +
      '<ellipse cx="-108" cy="8" rx="10" ry="24" transform="rotate(-8 -108 8)" fill="#22D3EE" opacity=".3"/>' +
      '<ellipse cx="108" cy="8" rx="10" ry="24" transform="rotate(8 108 8)" fill="#22D3EE" opacity=".3"/>',
    beanie: '<path d="M-110 -35 A 116 116 0 0 1 110 -35 Q 0 -70 -110 -35 Z" fill="url(#beanieGrad)"/>' +
      '<path d="M-112 -35 Q 0 -62 112 -35 L 112 -18 Q 0 -45 -112 -18 Z" fill="#B91C1C"/>' +
      '<path d="M-94 -50 Q 0 -130 94 -50" stroke="#FCA5A5" stroke-width="4" opacity=".4" fill="none"/>',
    nightcap: '<path d="M-110 -35 A 116 116 0 0 1 110 -35 Q 0 -70 -110 -35 Z" fill="url(#nightcapGrad)"/>' +
      '<path d="M-112 -35 Q 0 -62 112 -35 L 112 -18 Q 0 -45 -112 -18 Z" fill="#4338CA"/>' +
      '<path d="M 96 -52 Q 150 -76 160 -28 Q 168 10 140 24" stroke="url(#nightcapGrad)" stroke-width="20" fill="none" stroke-linecap="round"/>' +
      '<circle cx="140" cy="24" r="12" fill="#F8FAFC"/>',
    scarf: '<g clip-path="url(#ballClip)">' +
      '<rect x="-120" y="52" width="240" height="36" fill="url(#scarfGrad)"/>' +
      '<rect x="-120" y="52" width="240" height="6" fill="#FCA5A5" opacity=".35"/>' +
      '<rect x="-120" y="82" width="240" height="6" fill="#7F1D1D" opacity=".35"/>' +
      '</g>' +
      '<path d="M 84 74 Q 116 120 96 148 Q 86 160 72 150 Q 92 128 72 78 Z" fill="#B91C1C"/>',
    sunglasses: '<ellipse cx="-46" cy="0" rx="30" ry="19" transform="rotate(-6 -46 0)" fill="url(#lensGrad)"/>' +
      '<ellipse cx="46" cy="0" rx="30" ry="19" transform="rotate(6 46 0)" fill="url(#lensGrad)"/>' +
      '<path d="M -18 0 Q 0 -6 18 0" stroke="#0B1220" stroke-width="4" fill="none"/>' +
      '<path d="M -68 -6 Q -58 -12 -46 -7" stroke="#ffffff" stroke-width="3" opacity=".45" fill="none" stroke-linecap="round"/>' +
      '<path d="M 46 -7 Q 58 -12 68 -6" stroke="#ffffff" stroke-width="3" opacity=".45" fill="none" stroke-linecap="round"/>',
    badge: '<path d="M-38 70 Q 0 60 38 70 L 34 106 Q 0 114 -34 106 Z" fill="url(#patchGrad)" stroke="rgba(11,18,32,.14)" stroke-width="1"/>' +
      '<circle cx="0" cy="82" r="5" fill="#0EA5E9"/>' +
      '<rect x="-16" y="92" width="32" height="4" rx="2" fill="#94A3B8"/>',
    umbrella: '<path d="M-38 70 Q 0 60 38 70 L 34 106 Q 0 114 -34 106 Z" fill="url(#patchGrad)" stroke="rgba(11,18,32,.14)" stroke-width="1"/>' +
      '<path d="M-24 84 Q0 60 24 84 Z" fill="#38BDF8"/>' +
      '<path d="M0 84 L0 98 Q0 104 6 104" stroke="#0F172A" stroke-width="3" fill="none" stroke-linecap="round"/>',
    coffee: '<path d="M-38 70 Q 0 60 38 70 L 34 106 Q 0 114 -34 106 Z" fill="url(#patchGrad)" stroke="rgba(11,18,32,.14)" stroke-width="1"/>' +
      '<rect x="-13" y="78" width="26" height="22" rx="5" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="2"/>' +
      '<path d="M13 84 Q21 84 21 90 Q21 96 13 96" stroke="#CBD5E1" stroke-width="3" fill="none"/>' +
      '<path d="M-6 72 Q-3 67 0 72 Q3 77 6 72" stroke="#94A3B8" stroke-width="2.5" fill="none" opacity=".8"/>',
    hood: '<path d="M-116 0 A 116 116 0 0 1 116 0 L 82 0 A 82 82 0 0 0 -82 0 Z" fill="url(#hoodGrad)"/>' +
      '<path d="M-116 0 A 116 116 0 0 1 116 0" stroke="#1D4ED8" stroke-width="6" fill="none"/>'
  };
  var dayIndex = (new Date().getDay() + 6) % 7;
  var weatherKey = 'clear';
  var orbs = [
    { el: dayOrb, angle: -0.5, dragging: false, x: 0, y: 0, tx: 0, ty: 0, grabX: 0, grabY: 0 },
    { el: weatherOrb, angle: Math.PI - 0.5, dragging: false, x: 0, y: 0, tx: 0, ty: 0, grabX: 0, grabY: 0 }
  ];

  function clearGroup(group) {
    while (group.firstChild) group.removeChild(group.firstChild);
  }

  function addPin(group, key, cx, cy, size) {
    if (!ASSETS[key]) return;
    var ns = 'http://www.w3.org/2000/svg';
    var image = document.createElementNS(ns, 'image');
    image.setAttribute('href', ASSETS[key]);
    image.setAttribute('x', cx - size / 2);
    image.setAttribute('y', cy - size / 2);
    image.setAttribute('width', size);
    image.setAttribute('height', size);
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    image.setAttribute('filter', 'url(#assetShadow)');
    group.appendChild(image);
  }

  function renderOutfit() {
    var day = weekdays[dayIndex];
    var weather = weathers[weatherKey];
    clearGroup(stickerDaily);
    clearGroup(stickerWeather);
    dayIcon.src = ASSETS[day.sticker];
    weatherIcon.src = ASSETS[weather.badge];
    dayOrb.setAttribute('aria-label', '今天的贴纸：' + day.name);
    weatherOrb.setAttribute('aria-label', '天气：' + weather.text);
    document.querySelectorAll('#dayControls button').forEach(function (button) {
      button.classList.toggle('active', Number(button.getAttribute('data-day')) === dayIndex);
    });
    document.querySelectorAll('#weatherControls button').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-weather') === weatherKey);
    });
  }

  var dragging = false;
  var moved = 0;
  var pointerX = CX;
  var pointerY = CY;
  var lastPX = CX;
  var lastPY = CY;
  var pointerNX = 0;
  var pointerNY = 0;
  var press = 0;
  var pressV = 0;
  var flatten = 1;
  var flattenV = 0;
  var hop = 0;
  var hopV = 0;
  var state = 'idle';
  var stateEnd = 0;
  var blinkUntil = 0;
  var nextBlink = 2.4;
  var elapsed = 0;
  var last = performance.now();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smoothPath(pts) {
    var d = 'M' + pts[0].x.toFixed(2) + ',' + pts[0].y.toFixed(2);
    for (var i = 0; i < pts.length; i += 1) {
      var p0 = pts[(i - 1 + pts.length) % pts.length];
      var p1 = pts[i];
      var p2 = pts[(i + 1) % pts.length];
      var p3 = pts[(i + 2) % pts.length];
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += 'C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' +
        c2x.toFixed(2) + ',' + c2y.toFixed(2) + ' ' +
        p2.x.toFixed(2) + ',' + p2.y.toFixed(2);
    }
    return d + 'Z';
  }

  function setState(next, ms) {
    state = next;
    stateEnd = performance.now() + (ms || 2600);
    if (next === 'happy' || next === 'egg') {
      hopV -= 6;
    }
    var messages = {
      idle: '捏我一下。',
      happy: '你好呀。',
      sleep: 'Zzz… 先睡一会儿。',
      egg: '你找到我啦。'
    };
    bubble.textContent = messages[next] || messages.idle;
    bubble.classList.add('show');
    clearTimeout(window.__bubbleTimer);
    window.__bubbleTimer = setTimeout(function () {
      bubble.classList.remove('show');
    }, ms || 2600);
    zzz.style.opacity = next === 'sleep' ? '1' : '0';
    eyesNormal.setAttribute('opacity', next === 'idle' ? '1' : '0');
    eyesHappy.setAttribute('opacity', next === 'happy' ? '1' : '0');
    eyesSleep.setAttribute('opacity', next === 'sleep' ? '1' : '0');
    eyesStar.setAttribute('opacity', next === 'egg' ? '1' : '0');
    mouthHappy.setAttribute('opacity', next === 'happy' || next === 'egg' ? '1' : '0');
  }

  function pointerPosition(event) {
    var rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 420,
      y: ((event.clientY - rect.top) / rect.height) * 420
    };
  }

  viewport.addEventListener('pointerdown', function (event) {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    moved = 0;
    var p = pointerPosition(event);
    pointerX = p.x;
    pointerY = p.y;
    lastPX = p.x;
    lastPY = p.y;
    viewport.classList.add('grabbing');
    try { viewport.setPointerCapture(event.pointerId); } catch (err) {}
  });

  viewport.addEventListener('pointermove', function (event) {
    var p = pointerPosition(event);
    pointerX = p.x;
    pointerY = p.y;
    pointerNX = (p.x / 420 - 0.5) * 2;
    pointerNY = (p.y / 420 - 0.5) * 2;
    if (!dragging) return;
    moved += Math.abs(p.x - lastPX) + Math.abs(p.y - lastPY);
    lastPX = p.x;
    lastPY = p.y;
    var dx = pointerX - CX;
    var dy = pointerY - CY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var dir = Math.atan2(dy, dx);
    var strength = Math.min(dist / 200, 1) * 38;
    points.forEach(function (point) {
      var weight = Math.max(0, Math.cos(point.angle - dir));
      weight = Math.pow(weight, 3);
      point.tx = Math.cos(dir) * strength * weight;
      point.ty = Math.sin(dir) * strength * weight;
    });
  }, { passive: true });

  function release() {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove('grabbing');
    points.forEach(function (point) {
      point.tx = 0;
      point.ty = 0;
    });
    if (moved < 6) setState('happy');
  }
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);
  viewport.addEventListener('pointerleave', function () {
    pointerNX = 0;
    pointerNY = 0;
  });

  document.querySelectorAll('.controls button').forEach(function (button) {
    button.addEventListener('click', function () {
      var next = button.getAttribute('data-state');
      if (next === 'reset') {
        points.forEach(function (point) {
          point.dx = 0; point.dy = 0; point.vx = 0; point.vy = 0;
          point.tx = 0; point.ty = 0;
        });
        press = 0; pressV = 0; flatten = 1; flattenV = 0; hop = 0; hopV = 0;
        svg.style.transform = 'rotateX(0deg) rotateY(0deg)';
        setState('idle', 1600);
        return;
      }
      setState(next);
    });
  });

  if (dayControls) {
    dayControls.querySelectorAll('button').forEach(function (button) {
      button.addEventListener('click', function () {
        dayIndex = Number(button.getAttribute('data-day'));
        renderOutfit();
      });
    });
  }
  if (weatherControls) {
    weatherControls.querySelectorAll('button').forEach(function (button) {
      button.addEventListener('click', function () {
        weatherKey = button.getAttribute('data-weather');
        renderOutfit();
      });
    });
  }

  orbs.forEach(function (orb) {
    orb.el.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
      orb.dragging = true;
      orb.el.classList.add('grabbing');
      var rect = viewport.getBoundingClientRect();
      var px = event.clientX - rect.left - rect.width / 2;
      var py = event.clientY - rect.top - rect.height / 2;
      orb.grabX = px - orb.x;
      orb.grabY = py - orb.y;
      try { orb.el.setPointerCapture(event.pointerId); } catch (err) {}
    });
    orb.el.addEventListener('pointermove', function (event) {
      if (!orb.dragging) return;
      var rect = viewport.getBoundingClientRect();
      var px = event.clientX - rect.left - rect.width / 2;
      var py = event.clientY - rect.top - rect.height / 2;
      orb.tx = px - orb.grabX;
      orb.ty = py - orb.grabY;
    });
    function stop() {
      if (!orb.dragging) return;
      orb.dragging = false;
      orb.el.classList.remove('grabbing');
    }
    orb.el.addEventListener('pointerup', stop);
    orb.el.addEventListener('pointercancel', stop);
  });

  var buffer = '';
  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var el = event.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' || el.isContentEditable)) return;
    buffer = (buffer + event.key.toLowerCase()).slice(-2);
    if (buffer === 'gh') {
      buffer = '';
      setState('egg', 3200);
    }
  });

  function animate(now) {
    requestAnimationFrame(animate);
    var dt = Math.min((now - last) / 1000, 0.033);
    last = now;
    elapsed += dt;

    if (state !== 'idle' && now > stateEnd) {
      state = 'idle';
      zzz.style.opacity = '0';
      eyesNormal.setAttribute('opacity', '1');
      eyesHappy.setAttribute('opacity', '0');
      eyesSleep.setAttribute('opacity', '0');
      eyesStar.setAttribute('opacity', '0');
      mouthHappy.setAttribute('opacity', '0');
    }

    var pressTarget = dragging ? -5 : 0;
    pressV += (pressTarget - press) * 160 * dt;
    pressV *= Math.max(0, 1 - 10 * dt);
    press += pressV * dt;

    var flattenTarget = state === 'sleep' ? 0.86 : 1;
    flattenV += (flattenTarget - flatten) * 120 * dt;
    flattenV *= Math.max(0, 1 - 9 * dt);
    flatten += flattenV * dt;

    hopV += (0 - hop) * 130 * dt;
    hopV *= Math.max(0, 1 - 8 * dt);
    hop += hopV * dt;

    var pts = [];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var sumX = 0, sumY = 0;
    for (var i = 0; i < N; i += 1) {
      var point = points[i];
      var k = 150;
      point.vx += (point.tx - point.dx) * k * dt;
      point.vy += (point.ty - point.dy) * k * dt;
      point.vx *= Math.max(0, 1 - 9 * dt);
      point.vy *= Math.max(0, 1 - 9 * dt);
      point.dx += point.vx * dt;
      point.dy += point.vy * dt;

      var wave = reduce ? 0 : Math.sin(elapsed * 1.6 + i * 0.55) * 2;
      var radius = R + wave + press;
      var x = CX + radius * Math.cos(point.angle) + point.dx;
      var y = CY + radius * Math.sin(point.angle) * flatten + point.dy + hop;
      pts.push({ x: x, y: y });
      sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    path.setAttribute('d', smoothPath(pts));
    staticCircle.style.display = 'none';

    var avgX = sumX / N;
    var avgY = sumY / N;
    var sx = clamp((maxX - minX) / (2 * R), 0.9, 1.12);
    var sy = clamp((maxY - minY) / (2 * R), 0.9, 1.12);
    face.setAttribute('transform', 'translate(' + avgX.toFixed(1) + ' ' + avgY.toFixed(1) + ') scale(' + sx.toFixed(3) + ' ' + sy.toFixed(3) + ')');
    hiGroup.setAttribute('transform', 'translate(' + avgX.toFixed(1) + ' ' + avgY.toFixed(1) + ') scale(' + sx.toFixed(3) + ' ' + sy.toFixed(3) + ')');

    var tiltY = pointerNX * 5;
    var tiltX = -pointerNY * 4;
    svg.style.transform = 'rotateX(' + tiltX.toFixed(2) + 'deg) rotateY(' + tiltY.toFixed(2) + 'deg)';

    if (state === 'idle' && !reduce) {
      if (elapsed > nextBlink) {
        blinkUntil = elapsed + 0.12;
        nextBlink = elapsed + 3 + Math.random() * 3;
      }
    }
    var blinking = elapsed < blinkUntil;
    var eyeY = 1;
    if (state === 'sleep') eyeY = 0.1;
    else if (state === 'happy' || state === 'egg') eyeY = 1;
    else if (blinking) eyeY = 0.12;
    eyesNormal.setAttribute('transform', 'scale(1 ' + eyeY.toFixed(3) + ')');

    var orbitRadius = Math.min(viewport.clientWidth, viewport.clientHeight) * 0.37;
    orbs.forEach(function (orb) {
      if (!orb.dragging) {
        orb.angle += dt * 0.12;
        orb.tx = Math.cos(orb.angle) * orbitRadius;
        orb.ty = Math.sin(orb.angle) * orbitRadius;
      }
      orb.x += (orb.tx - orb.x) * 0.16;
      orb.y += (orb.ty - orb.y) * 0.16;
      orb.el.style.transform =
        'translate(' + orb.x.toFixed(1) + 'px,' + orb.y.toFixed(1) + 'px)';
    });
  }

  bubble.textContent = '捏我一下。';
  bubble.classList.add('show');
  window.__bubbleTimer = setTimeout(function () { bubble.classList.remove('show'); }, 3200);
  renderOutfit();
  requestAnimationFrame(animate);
})();
</script>
</body>
</html>`;

const path = join(tmpdir(), 'robot-orbit.html');
writeFileSync(path, html, 'utf8');
console.log(path);
