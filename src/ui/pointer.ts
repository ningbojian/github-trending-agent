/**
 * 全站玻璃卡片的指针效果：卡片里一团柔光跟着鼠标走。
 *
 * 与面板机器人脚本独立；所有网页都加载，触屏或减弱动态时不做。
 * 无脚本时卡片只是静态玻璃，不影响功能。
 */
export const POINTER_SCRIPT = `
(function () {
  if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
  var cards = document.querySelectorAll('.p-card');
  if (cards.length === 0) return;
  cards.forEach(function (card) {
    card.addEventListener('pointermove', function (event) {
      var rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
      card.style.setProperty('--my', (event.clientY - rect.top) + 'px');
    }, { passive: true });
    card.addEventListener('pointerleave', function () {
      card.style.setProperty('--mx', '50%');
      card.style.setProperty('--my', '0%');
    });
  });
})();
`;
