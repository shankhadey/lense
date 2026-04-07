/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  LENSE — ELEMENTS MODULE                                     ║
 * ║  Spotlight and callout element storage, timeline rendering,   ║
 * ║  AI suggestion UI (Effect Picker cards).                     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

// ─── ELEMENT STORE ────────────────────────────────────────────────────────────
// Accepted elements (applied to the video during re-render).
// Each element: { type, t, duration, cx, cy, w?, h?, label?, arrowFromX?, arrowFromY? }
const elements = {
  items: [],      // accepted/active elements
  add(el) { this.items.push(el); },
  remove(id) { this.items = this.items.filter(e => e._id !== id); },
  removeBySugg(suggId) { this.items = this.items.filter(e => e.suggId !== suggId); },
  clear() { this.items = []; },
  atTime(tMs) {
    return this.items.filter(e => tMs >= e.t && tMs <= e.t + e.duration);
  },
};

// ─── AI SUGGESTION → ELEMENT CONVERSION ───────────────────────────────────────

/**
 * Convert an accepted AI suggestion into one or more concrete elements.
 * Respects suggestion.active (single type) or applies all qualified types.
 */
function suggestionToElements(s, applyAll = false) {
  const types = applyAll ? s.qualified.map(q => q.type) : [s.active || s.recommended];
  const id = s._id;

  return types.map(type => {
    const dur = CONFIG['AI_' + type.toUpperCase() + '_DURATION_MS'] || 3000;
    const base = { _id: id + '_' + type, t: s.t, duration: dur, cx: s.cx, cy: s.cy, source: 'ai' };
    if (type === 'zoom') {
      return { ...base, type: 'zoom' };
    }
    if (type === 'spotlight') {
      // Default spotlight box: 30% × 25% of frame, centred on activity region
      return { ...base, type: 'spotlight', w: 0.30, h: 0.25 };
    }
    if (type === 'callout') {
      return {
        ...base,
        type: 'callout',
        label: s.label || 'See this',
        arrowFromX: Math.max(0.05, s.cx - 0.15),
        arrowFromY: Math.max(0.05, s.cy - 0.12),
      };
    }
    return null;
  }).filter(Boolean);
}

// ─── TIMELINE MARKERS ─────────────────────────────────────────────────────────

/**
 * Render AI suggestion dashed markers onto the review timeline.
 * Called by app.js whenever aiSuggestions or elements change.
 *
 * @param {HTMLElement} trackEl   #rv-timeline-track
 * @param {number} totalMs        recording duration in ms
 * @param {Array} aiSuggestions   state.aiSuggestions
 */
function renderAIMarkers(trackEl, totalMs, aiSuggestions) {
  // Remove existing AI markers
  trackEl.querySelectorAll('.rv-ai-marker').forEach(m => m.remove());

  if (!totalMs) return;

  aiSuggestions.forEach(s => {
    if (s.dismissed) return;
    const pct = (s.t / totalMs) * 100;
    const marker = document.createElement('div');
    marker.className = 'rv-ai-marker rv-ai-' + (s.active || s.recommended);
    marker.style.left = pct + '%';
    marker.title = `✦ ${fmtMs(s.t)} — ${s.label} (${s.active || s.recommended})`;
    marker.dataset.suggId = s._id;
    trackEl.appendChild(marker);
  });
}

// ─── SUGGESTION CARD UI ───────────────────────────────────────────────────────

/**
 * Render all AI suggestion cards into the AI tab list.
 *
 * @param {HTMLElement} listEl     #ai-suggestion-list
 * @param {Array} aiSuggestions    state.aiSuggestions
 * @param {object} callbacks       { onAccept, onAcceptAll, onDismiss, onRemove, onLabelEdit, onTypeChange }
 */
function renderSuggestionCards(listEl, aiSuggestions, callbacks, showDismissed = false) {
  listEl.innerHTML = '';

  const visible = aiSuggestions.filter(s => !s.dismissed);
  const dismissed = aiSuggestions.filter(s => s.dismissed);

  if (!visible.length && !dismissed.length) {
    listEl.innerHTML = '<p class="ai-empty">No suggestions yet.</p>';
    return;
  }

  visible.forEach(s => listEl.appendChild(buildCard(s, false, callbacks)));

  if (dismissed.length && showDismissed) {
    const sep = document.createElement('div');
    sep.className = 'ai-dismissed-sep';
    sep.textContent = `Dismissed (${dismissed.length})`;
    listEl.appendChild(sep);
    dismissed.forEach(s => listEl.appendChild(buildCard(s, true, callbacks)));
  }
}

function buildCard(s, isDismissed, cb) {
  const isConflict = s.qualified.length > 1 && !s.active;
  const card = document.createElement('div');
  card.className = 'ai-card' + (isDismissed ? ' ai-card-dismissed' : '') +
    (isConflict ? ' ai-card-conflict' : '');
  card.dataset.suggId = s._id;

  const typeLabel = s.active || s.recommended;
  const icon = { zoom: '🔍', spotlight: '💡', callout: '📌' }[typeLabel] || '✦';
  const conf = Math.round(s.confidence * 100);

  card.innerHTML = `
    <div class="ai-card-header">
      <span class="ai-card-icon">${icon}</span>
      <span class="ai-card-time">${fmtMs(s.t)}</span>
      <span class="ai-card-conf">${conf}%</span>
      <span class="ai-card-type ai-type-${typeLabel}">${typeLabel}</span>
    </div>

    ${isConflict ? `
    <div class="ai-card-picker">
      <span class="ai-card-picker-label">Qualifies for:</span>
      <div class="ai-type-radios">
        ${s.qualified.map(q => `
          <label class="ai-type-radio">
            <input type="radio" name="type-${s._id}" value="${q.type}"
              ${q.type === s.recommended ? 'checked' : ''} />
            <span class="ai-type-chip ai-type-${q.type}">${q.type}</span>
          </label>`).join('')}
      </div>
    </div>` : ''}

    ${typeLabel === 'callout' || (isConflict && s.qualified.some(q => q.type === 'callout')) ? `
    <div class="ai-card-label-row">
      <span class="ai-card-label-pre">Label:</span>
      <input class="ai-card-label-input" type="text" value="${escapeAttr(s.label)}"
        placeholder="Callout text (from transcript)" data-sugg-id="${s._id}" />
    </div>` : ''}

    <div class="ai-card-actions">
      ${isDismissed ? `
        <button class="ai-action-btn sm" data-action="restore" data-id="${s._id}">Restore</button>
        <button class="ai-ghost-btn sm danger" data-action="remove" data-id="${s._id}">Remove</button>
      ` : `
        ${s.accepted
          ? `<button class="ai-action-btn sm" disabled>Applied ✓</button>`
          : `<button class="ai-action-btn sm" data-action="accept" data-id="${s._id}">Apply${isConflict ? ' selected' : ''}</button>
        ${isConflict ? `<button class="ai-ghost-btn sm" data-action="accept-all" data-id="${s._id}">Apply all</button>` : ''}`}
        <button class="ai-ghost-btn sm" data-action="dismiss" data-id="${s._id}">Dismiss</button>
        <button class="ai-ghost-btn sm danger" data-action="remove" data-id="${s._id}">Remove</button>
      `}
    </div>`;

  // Wire events
  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'accept') {
        // Read selected radio if conflict card
        const radio = card.querySelector(`input[name="type-${id}"]:checked`);
        if (radio) s.active = radio.value;
        else if (!s.active) s.active = s.recommended;
        cb.onAccept(s, false);
      } else if (action === 'accept-all') {
        cb.onAccept(s, true);
      } else if (action === 'dismiss') {
        cb.onDismiss(s);
      } else if (action === 'restore') {
        cb.onRestore(s);
      } else if (action === 'remove') {
        cb.onRemove(s);
      }
    });
  });

  // Label edit
  const labelInput = card.querySelector('.ai-card-label-input');
  if (labelInput) {
    labelInput.addEventListener('input', () => {
      s.label = labelInput.value.slice(0, 60);
      cb.onLabelEdit(s);
    });
  }

  return card;
}

// ─── CANVAS DRAWING ───────────────────────────────────────────────────────────

/**
 * Draw all active elements at time tMs onto the canvas context.
 * Call this from the render loop after drawing the zoomed video frame.
 */
function drawElements(ctx, W, H, tMs) {
  elements.atTime(tMs).forEach(el => {
    const age    = tMs - el.t;
    const remain = el.t + el.duration - tMs;
    const fade   = Math.min(1, Math.min(age, remain) / 300);

    if (el.type === 'spotlight') _drawSpotlight(ctx, el, W, H, fade);
    if (el.type === 'callout')   _drawCallout(ctx, el, W, H, fade);
  });
}

function _drawSpotlight(ctx, el, W, H, alpha) {
  ctx.save();
  // Dark overlay
  ctx.globalAlpha = 0.6 * alpha;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // Punch clear window through the overlay
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  const x = (el.cx - el.w / 2) * W;
  const y = (el.cy - el.h / 2) * H;
  ctx.fillRect(x, y, el.w * W, el.h * H);
  ctx.restore();
}

function _drawCallout(ctx, el, W, H, alpha) {
  const tipX = el.cx * W;
  const tipY = el.cy * H;
  const fromX = el.arrowFromX * W;
  const fromY = el.arrowFromY * H;
  const label = el.label || 'See this';

  ctx.save();
  ctx.globalAlpha = alpha;

  // Arrow line
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Dot at tip
  ctx.fillStyle = '#f97316';
  ctx.beginPath();
  ctx.arc(tipX, tipY, 8, 0, Math.PI * 2);
  ctx.fill();

  // Label box (positioned at arrow origin)
  ctx.font = 'bold 22px system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  const bx = fromX - tw / 2 - 12;
  const by = fromY - 24;
  const bw = tw + 24;
  const bh = 36;

  ctx.fillStyle = 'rgba(249,115,22,0.92)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx, by, bw, bh, 8);
  } else {
    ctx.rect(bx, by, bw, bh);
  }
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.fillText(label, fromX - tw / 2, fromY - 2);

  ctx.restore();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// formatTime() is defined in app.js (same global scope) — reuse it.
const fmtMs = ms => formatTime(ms);

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
