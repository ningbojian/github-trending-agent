import { escapeHtml } from '../http/html.js';
import {
  dayStickerFor,
  STICKER_CODES,
  weatherIconFor,
  WEATHER_CODES,
} from '../weather/outfit.js';
import type { Weather } from '../weather/service.js';

/**
 * 面板里的机器人：服务端渲染 SVG + 两颗环绕贴纸，客户端只负责捏和轨道。
 *
 * 不用 WebGL；SVG + 少量内联 JS，微信 WebView 能跑。
 * 日贴纸/天气图标在服务端决定，客户端不请求外部接口。
 */

const ROBOT_SVG = `<svg class="p-robot-svg" viewBox="0 0 420 420" role="img" aria-label="今日小机器人">
  <defs>
    <radialGradient id="prBlobFill" cx="35%" cy="28%" r="78%">
      <stop offset="0%" stop-color="#9dbdff"/>
      <stop offset="42%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </radialGradient>
    <radialGradient id="prBlobHi" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".65"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="prBubbleFill" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#a5f3fc"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </radialGradient>
    <filter id="prSoftShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#020617" flood-opacity=".35"/>
    </filter>
    <filter id="prBlurHi" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
  </defs>
  <ellipse cx="210" cy="344" rx="106" ry="18" fill="#020617" opacity=".28" filter="url(#prBlurHi)"/>
  <circle id="prBlobStatic" cx="210" cy="205" r="116" fill="url(#prBlobFill)" filter="url(#prSoftShadow)"/>
  <path id="prBlobPath" d="" fill="url(#prBlobFill)" filter="url(#prSoftShadow)"/>
  <g id="prHiGroup" transform="translate(210 205)">
    <ellipse cx="-48" cy="-54" rx="64" ry="44" fill="url(#prBlobHi)" filter="url(#prBlurHi)" opacity=".65"/>
  </g>
  <g id="prFace" transform="translate(210 205)">
    <g class="p-robot-antenna">
      <ellipse cx="0" cy="-102" rx="16" ry="7" fill="#1e40af"/>
      <path d="M0 -100 L0 -138" stroke="#2563eb" stroke-width="12" stroke-linecap="round"/>
      <circle cx="0" cy="-154" r="20" fill="url(#prBubbleFill)"/>
      <circle cx="-6" cy="-160" r="6" fill="#ffffff" opacity=".7"/>
    </g>
    <g id="prEyes">
      <ellipse cx="-46" cy="0" rx="23" ry="27" fill="#0B1220"/>
      <circle cx="-54" cy="-10" r="6" fill="#ffffff"/>
      <ellipse cx="46" cy="0" rx="23" ry="27" fill="#0B1220"/>
      <circle cx="38" cy="-10" r="6" fill="#ffffff"/>
    </g>
  </g>
</svg>`;

export const ROBOT_ATTRIBUTION = 'Emoji artwork: Twemoji (CC-BY 4.0)';

export function renderRobotMascot(weather: Weather | null, now: Date = new Date()): string {
  const day = dayStickerFor(now);
  const weatherIcon = weatherIconFor(weather);
  const daySrc = `/docs/assets/emoji/${STICKER_CODES[day.sticker]}.svg`;
  const weatherSrc = `/docs/assets/emoji/${WEATHER_CODES[weatherIcon]}.svg`;
  const weatherLabel = weather === null ? '暂无天气' : `${weather.city} ${weather.temperature}°C`;

  return `<div class="p-mascot" data-robot-stage>
    ${ROBOT_SVG}
    <div class="p-orb" data-orb="day" role="img" aria-label="${escapeHtml(`今日贴纸：${day.name}`)}">
      <img src="${daySrc}" alt="">
    </div>
    <div class="p-orb" data-orb="weather" role="img" aria-label="${escapeHtml(`天气：${weatherLabel}`)}">
      <img src="${weatherSrc}" alt="">
    </div>
  </div>`;
}

/**
 * 客户端脚本：捏球 + 两颗贴纸环绕/拖拽。
 * 无依赖；没有它也能看到静态机器人和贴纸。
 */
export const ROBOT_SCRIPT = `
(function () {
  var stage = document.querySelector('[data-robot-stage]');
  if (!stage) return;
  var svg = stage.querySelector('svg');
  var path = stage.querySelector('#prBlobPath');
  var staticCircle = stage.querySelector('#prBlobStatic');
  var face = stage.querySelector('#prFace');
  var hiGroup = stage.querySelector('#prHiGroup');
  var eyes = stage.querySelector('#prEyes');
  if (!svg || !path || !face || !hiGroup || !staticCircle) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var CX = 210, CY = 205, R = 116, N = 14;
  var points = [];
  for (var i = 0; i < N; i += 1) {
    points.push({ angle: (i / N) * Math.PI * 2, dx: 0, dy: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
  }
  var dragging = false, moved = 0, lastPX = 0, lastPY = 0;
  var pointerNX = 0, pointerNY = 0;
  var press = 0, pressV = 0, hop = 0, hopV = 0;
  var blinkUntil = 0, nextBlink = 2.6, elapsed = 0;
  var last = performance.now();

  var orbs = [];
  stage.querySelectorAll('.p-orb').forEach(function (el, index) {
    orbs.push({
      el: el,
      angle: index === 0 ? -0.5 : Math.PI - 0.5,
      dragging: false,
      x: 0, y: 0, tx: 0, ty: 0, grabX: 0, grabY: 0
    });
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smoothPath(pts) {
    var d = 'M' + pts[0].x.toFixed(2) + ',' + pts[0].y.toFixed(2);
    for (var j = 0; j < pts.length; j += 1) {
      var p0 = pts[(j - 1 + pts.length) % pts.length];
      var p1 = pts[j];
      var p2 = pts[(j + 1) % pts.length];
      var p3 = pts[(j + 2) % pts.length];
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

  function pointerPosition(event) {
    var rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 420,
      y: ((event.clientY - rect.top) / rect.height) * 420
    };
  }

  stage.addEventListener('pointerdown', function (event) {
    if (event.target && event.target.closest && event.target.closest('.p-orb')) return;
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    moved = 0;
    var p = pointerPosition(event);
    lastPX = p.x;
    lastPY = p.y;
    stage.classList.add('grabbing');
    try { stage.setPointerCapture(event.pointerId); } catch (err) {}
  });

  stage.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    var p = pointerPosition(event);
    moved += Math.abs(p.x - lastPX) + Math.abs(p.y - lastPY);
    lastPX = p.x;
    lastPY = p.y;
    var dx = p.x - CX;
    var dy = p.y - CY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var dir = Math.atan2(dy, dx);
    var strength = Math.min(dist / 200, 1) * 38;
    points.forEach(function (point) {
      var weight = Math.pow(Math.max(0, Math.cos(point.angle - dir)), 3);
      point.tx = Math.cos(dir) * strength * weight;
      point.ty = Math.sin(dir) * strength * weight;
    });
  }, { passive: true });

  function release() {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('grabbing');
    points.forEach(function (point) { point.tx = 0; point.ty = 0; });
    if (moved < 6) hopV -= 4.5;
  }
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // 眼睛/轻微倾斜跟随整页鼠标，而不是只在机器人上拖动时才动。
  document.addEventListener('pointermove', function (event) {
    var rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    var nx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    var ny = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    pointerNX = clamp(nx, -1.6, 1.6);
    pointerNY = clamp(ny, -1.6, 1.6);
  }, { passive: true });
  document.addEventListener('pointerleave', function () {
    pointerNX = 0;
    pointerNY = 0;
  });

  stage.querySelectorAll('.p-orb').forEach(function (orb) {
    orb.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
      var rect = stage.getBoundingClientRect();
      var px = event.clientX - rect.left - rect.width / 2;
      var py = event.clientY - rect.top - rect.height / 2;
      var index = orbs.findIndex(function (item) { return item.el === orb; });
      if (index < 0) return;
      var item = orbs[index];
      item.dragging = true;
      orb.classList.add('grabbing');
      item.grabX = px - item.x;
      item.grabY = py - item.y;
      try { orb.setPointerCapture(event.pointerId); } catch (err) {}
    });
    orb.addEventListener('pointermove', function (event) {
      var index = orbs.findIndex(function (item) { return item.el === orb; });
      if (index < 0) return;
      var item = orbs[index];
      if (!item.dragging) return;
      var rect = stage.getBoundingClientRect();
      item.tx = event.clientX - rect.left - rect.width / 2 - item.grabX;
      item.ty = event.clientY - rect.top - rect.height / 2 - item.grabY;
    });
    function stop() {
      var index = orbs.findIndex(function (item) { return item.el === orb; });
      if (index < 0) return;
      orbs[index].dragging = false;
      orb.classList.remove('grabbing');
    }
    orb.addEventListener('pointerup', stop);
    orb.addEventListener('pointercancel', stop);
  });

  function animate(now) {
    requestAnimationFrame(animate);
    var dt = Math.min((now - last) / 1000, 0.033);
    last = now;
    elapsed += dt;
    var width = stage.clientWidth;
    var height = stage.clientHeight;
    if (width === 0 || height === 0) return;

    pressV += ((dragging ? -4 : 0) - press) * 150 * dt;
    pressV *= Math.max(0, 1 - 10 * dt);
    press += pressV * dt;
    hopV += (0 - hop) * 130 * dt;
    hopV *= Math.max(0, 1 - 8 * dt);
    hop += hopV * dt;

    var pts = [];
    var sumX = 0, sumY = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var j = 0; j < N; j += 1) {
      var point = points[j];
      point.vx += (point.tx - point.dx) * 150 * dt;
      point.vy += (point.ty - point.dy) * 150 * dt;
      point.vx *= Math.max(0, 1 - 9 * dt);
      point.vy *= Math.max(0, 1 - 9 * dt);
      point.dx += point.vx * dt;
      point.dy += point.vy * dt;
      var wave = reduce ? 0 : Math.sin(elapsed * 1.6 + j * 0.55) * 2;
      var radius = R + wave + press;
      var x = CX + radius * Math.cos(point.angle) + point.dx;
      var y = CY + radius * Math.sin(point.angle) + point.dy + hop;
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
    var transform = 'translate(' + avgX.toFixed(1) + ' ' + avgY.toFixed(1) + ') scale(' +
      sx.toFixed(3) + ' ' + sy.toFixed(3) + ')';
    face.setAttribute('transform', transform);
    hiGroup.setAttribute('transform', transform);

    var orbitRadius = Math.min(width, height) * 0.44;
    orbs.forEach(function (orb) {
      if (!orb.dragging) {
        orb.angle += dt * 0.12;
        orb.tx = Math.cos(orb.angle) * orbitRadius;
        orb.ty = Math.sin(orb.angle) * orbitRadius;
      }
      orb.x += (orb.tx - orb.x) * 0.16;
      orb.y += (orb.ty - orb.y) * 0.16;
      orb.el.style.transform = 'translate(' + orb.x.toFixed(1) + 'px,' + orb.y.toFixed(1) + 'px)';
    });

    if (!reduce) {
      if (elapsed > nextBlink) {
        blinkUntil = elapsed + 0.12;
        nextBlink = elapsed + 3 + Math.random() * 3;
      }
    }
    var blinking = elapsed < blinkUntil;
    if (eyes) {
      var eyeX = (pointerNX * 8).toFixed(2);
      var eyeY = (pointerNY * 6).toFixed(2);
      eyes.setAttribute(
        'transform',
        'translate(' + eyeX + ' ' + eyeY + ') scale(1 ' +
          (blinking ? 0.12 : 1) + ')',
      );
    }
    svg.style.transform = 'rotateX(' + (-pointerNY * 3).toFixed(2) + 'deg) rotateY(' +
      (pointerNX * 4).toFixed(2) + 'deg)';
  }
  requestAnimationFrame(animate);
})();
`;
