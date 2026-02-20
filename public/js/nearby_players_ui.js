// =================================================================
// NEARBY PLAYERS UI — Who's on this map, with action buttons
// =================================================================
// Teaching: Game.players is a live dictionary { charId -> playerObj }
// that already exists and updates via socket events. All we need to
// do is READ it and render the list — no extra server calls needed.
//
// Player objects have:
//   { charId, name, level, mapId, x, y, role }
//
// We filter to only show players whose mapId matches Game.myHero.mapId
// (everyone on the same map), excluding ourselves.
//
// Each player row has three action buttons:
//   [💬 DM]       — opens ChatUI on DM tab with this player pre-filled
//   [🤝 Trade]    — sends a trade_request socket event via TradeUI
//   [⚔️ Challenge] — sends a battle_challenge socket event (PvP)
//
// The panel is attached to the existing 👥 player count element in the
// HUD. Clicking it toggles the panel open/closed. The panel is a small
// absolutely-positioned popup — it doesn't block gameplay.
//
// Auto-refresh: NearbyUI.refresh() is called by game_engine.js whenever
// player_joined, player_left, or player_list fires. If the panel is
// closed, refresh() is a no-op. No polling needed.
// =================================================================

const NearbyUI = {

    // ─── STATE ───────────────────────────────────────────────────
    open: false,

    // ─── INIT ────────────────────────────────────────────────────
    // Called once after login. Wires the click handler onto the
    // existing 👥 playerCount element in the HUD.
    init() {
        const countEl = document.getElementById('playerCount');
        if (!countEl) return;

        // Make the player count look clickable
        countEl.style.cursor  = 'pointer';
        countEl.title         = 'Click to see who\'s on this map';
        countEl.style.transition = 'color .15s';
        countEl.addEventListener('mouseenter', () => countEl.style.color = '#03dac6');
        countEl.addEventListener('mouseleave', () => countEl.style.color = '');
        countEl.addEventListener('click', () => NearbyUI.toggle());

        // Close on Escape (handled by game_engine.js hotkey block,
        // but also handle directly so it works even in dialogs)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && NearbyUI.open) NearbyUI.close();
        });
    },

    // ─── TOGGLE ──────────────────────────────────────────────────
    toggle() {
        NearbyUI.open ? NearbyUI.close() : NearbyUI.openPanel();
    },

    openPanel() {
        NearbyUI.open = true;
        NearbyUI._buildShell();
        NearbyUI.refresh();
    },

    close() {
        NearbyUI.open = false;
        const el = document.getElementById('nearbyPanel');
        if (el) el.remove();
    },

    // ─── REFRESH ─────────────────────────────────────────────────
    // Called automatically by game_engine.js when the player list changes.
    // Safe to call even when panel is closed — returns immediately.
    refresh() {
        if (!NearbyUI.open) return;
        const panel = document.getElementById('nearbyPanel');
        if (!panel) return;

        const myCharId  = typeof Game !== 'undefined' ? Game.myCharId  : null;
        const myMapId   = typeof Game !== 'undefined' && Game.myHero ? Game.myHero.mapId : null;

        // Filter to same map, excluding self
        const others = Object.values(
            typeof Game !== 'undefined' ? Game.players : {}
        ).filter(p => p.charId !== myCharId && p.mapId === myMapId);

        // Update the count badge in the HUD
        const countEl = document.getElementById('playerCount');
        if (countEl) countEl.innerHTML = `👥 ${others.length + 1}`;  // +1 for self

        const listEl = document.getElementById('nearbyList');
        if (!listEl) return;

        if (!others.length) {
            listEl.innerHTML = `<div style="color:#484f58;font-size:12px;text-align:center;padding:16px 0">
                No other players on this map.</div>`;
            return;
        }

        listEl.innerHTML = others.map(p => NearbyUI._row(p)).join('');
    },

    // ─── PLAYER ROW ──────────────────────────────────────────────
    _row(p) {
        const roleColor = { ADMIN: '#f85149', GM: '#f85149', MOD: '#bb86fc',
                            STAFF: '#bb86fc', OWNER: '#f39c12' }[p.role] || '';
        const roleIcon  = { ADMIN: '🔑', GM: '⚡', MOD: '🛡️',
                            STAFF: '🔧', OWNER: '👑' }[p.role] || '';

        // Check if they're in our party (for green name highlight)
        const inParty = typeof PartyUI !== 'undefined' && PartyUI.partyIds
                      ? PartyUI.partyIds.includes(p.charId)
                      : false;
        const nameColor = inParty ? '#3fb950' : (roleColor || '#c9d1d9');

        return `
        <div class="nb-row" id="nb-row-${p.charId}">
            <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:5px">
                    ${roleIcon ? `<span style="font-size:11px">${roleIcon}</span>` : ''}
                    <span style="font-weight:bold;color:${nameColor};font-size:13px;
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                        title="${NearbyUI._esc(p.name)}">${NearbyUI._esc(p.name)}</span>
                </div>
                <div style="color:#484f58;font-size:10px">Lv.${p.level || '?'}
                    ${inParty ? ' · <span style="color:#3fb950">Party</span>' : ''}</div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
                <button class="nb-btn nb-dm"
                    onclick="NearbyUI.dm(${p.charId},'${NearbyUI._esc(p.name)}')"
                    title="Send DM">💬</button>
                <button class="nb-btn nb-trade"
                    onclick="NearbyUI.trade(${p.charId})"
                    title="Trade">🤝</button>
                <button class="nb-btn nb-pvp"
                    onclick="NearbyUI.challenge(${p.charId},'${NearbyUI._esc(p.name)}')"
                    title="PvP Challenge">⚔️</button>
            </div>
        </div>`;
    },

    // ─── ACTIONS ─────────────────────────────────────────────────
    dm(charId, name) {
        if (typeof ChatUI !== 'undefined') ChatUI.startDM(charId, name);
        NearbyUI.close();
    },

    trade(targetCharId) {
        if (typeof TradeUI !== 'undefined') {
            TradeUI.requestTrade(targetCharId);
        } else if (typeof Game !== 'undefined') {
            Game.socket.emit('trade_request', { targetCharId });
        }
        NearbyUI.close();
    },

    challenge(targetCharId, name) {
        if (!confirm(`Challenge ${name} to a PvP battle?`)) return;
        if (typeof Game !== 'undefined') {
            Game.socket.emit('battle_challenge', { targetCharId });
        }
        showNotification(`⚔️ Challenge sent to ${name}…`, 'battle');
        NearbyUI.close();
    },

    // ─── DOM SHELL ───────────────────────────────────────────────
    _buildShell() {
        let el = document.getElementById('nearbyPanel');
        if (el) el.remove();

        // Position: just below the playerCount element in the HUD
        const countEl = document.getElementById('playerCount');
        const hudEl   = document.getElementById('hud');
        const hudRect = hudEl ? hudEl.getBoundingClientRect() : { left: 10, bottom: 0 };

        el = document.createElement('div');
        el.id = 'nearbyPanel';
        el.style.cssText = `
            position: fixed;
            left: ${hudRect.left}px;
            top: ${hudRect.bottom + 8}px;
            width: 260px;
            max-height: 380px;
            overflow-y: auto;
            background: rgba(5,8,14,0.97);
            border: 1px solid rgba(3,218,198,0.25);
            border-radius: 10px;
            padding: 12px;
            z-index: 50;
            color: #e8eef6;
            box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        `;
        el.innerHTML = `
            ${NearbyUI._styles()}
            <div style="display:flex;justify-content:space-between;align-items:center;
                 margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #21262d">
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;
                     color:#03dac6;font-family:'Courier New',monospace;font-weight:bold">
                    👥 On This Map
                </div>
                <button onclick="NearbyUI.close()"
                    style="background:none;border:none;color:#484f58;cursor:pointer;
                    font-size:16px;line-height:1;padding:0">✕</button>
            </div>
            <div id="nearbyList">
                <div style="color:#484f58;font-size:12px;text-align:center;padding:16px 0">Loading…</div>
            </div>
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid #21262d;
                 color:#30363d;font-size:10px;text-align:center">
                💬 DM &nbsp;·&nbsp; 🤝 Trade &nbsp;·&nbsp; ⚔️ PvP Challenge
            </div>`;

        document.body.appendChild(el);

        // Close when clicking outside the panel
        setTimeout(() => {
            document.addEventListener('click', NearbyUI._outsideClick);
        }, 50); // small delay so the opening click doesn't immediately close it
    },

    _outsideClick(e) {
        const panel = document.getElementById('nearbyPanel');
        const count = document.getElementById('playerCount');
        if (panel && !panel.contains(e.target) && count && !count.contains(e.target)) {
            NearbyUI.close();
            document.removeEventListener('click', NearbyUI._outsideClick);
        }
    },

    _styles() {
        if (document.getElementById('nearbyStyles')) return '';
        const s = document.createElement('style');
        s.id = 'nearbyStyles';
        s.textContent = `
        .nb-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 6px;
            border-radius: 7px;
            transition: background .12s;
        }
        .nb-row:hover { background: rgba(255,255,255,0.04); }
        .nb-btn {
            width: 28px; height: 28px;
            background: rgba(255,255,255,0.05);
            border: 1px solid #21262d;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            display: flex; align-items: center; justify-content: center;
            transition: .12s;
            padding: 0;
        }
        .nb-dm:hover    { background: rgba(187,134,252,0.15); border-color: rgba(187,134,252,0.4); }
        .nb-trade:hover { background: rgba(3,218,198,0.12);   border-color: rgba(3,218,198,0.35); }
        .nb-pvp:hover   { background: rgba(248,81,73,0.12);   border-color: rgba(248,81,73,0.35); }`;
        document.head.appendChild(s);
        return '';
    },

    _esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
    },
};
