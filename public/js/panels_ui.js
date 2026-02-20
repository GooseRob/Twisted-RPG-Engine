// =================================================================
// PANELS UI v1.0 — Inventory, Equipment, Shop, Character Sheet
// =================================================================
// Hotkeys: [I] = Inventory/Equipment, [C] = Character Sheet, [ESC] = Close
// Integrated with game_engine.js — sets Game.dialogueOpen to block movement.

const Panels = {
    open: null,       // 'inventory' | 'shop' | 'character' | null
    charFull: null,   // Cached data from /get-char-full
    shopData: null,   // Cached shop data
    shopId: null,

    // =============================================================
    // FETCH CHARACTER DATA
    // =============================================================
    async fetchChar() {
        try {
            const r = await fetch('/get-char-full', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId })
            });
            const j = await r.json();
            if (j.success) { Panels.charFull = j; return j; }
        } catch (e) { console.error('Panel fetch error:', e); }
        return null;
    },

    // =============================================================
    // OPEN/CLOSE
    // =============================================================
    async openInventory() {
        if (BattleUI.active) return;
        await Panels.fetchChar();
        if (!Panels.charFull) { showNotification('Failed to load data', 'damage'); return; }
        Panels.open = 'inventory';
        Game.dialogueOpen = true;
        Panels.renderInventory();
    },

    async openCharacter(tab) {
        if (BattleUI.active) return;
        await Panels.fetchChar();
        if (!Panels.charFull) return;
        Panels.open = 'character';
        Game.dialogueOpen = true;
        Panels._progPending = Panels._progPending || null;
        const overlay = Panels._getOverlay();
        overlay.innerHTML = Panels._charSheetHTML(Panels.charFull, tab || 'overview');
    },

    async openShop(shopId) {
        if (BattleUI.active) return;
        Panels.shopId = shopId;
        const [charR, shopR] = await Promise.all([
            Panels.fetchChar(),
            fetch('/get-shop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopId }) }).then(r => r.json())
        ]);
        if (!charR || !shopR.success) { showNotification('Shop unavailable', 'damage'); return; }
        Panels.shopData = shopR;
        Panels.open = 'shop';
        Game.dialogueOpen = true;
        Panels.renderShop();
    },

    close() {
        Panels.open = null;
        Game.dialogueOpen = false;
        const el = document.getElementById('panelOverlay');
        if (el) el.remove();
        // Refresh HP/MP bars
        loadCharData();
    },

    // =============================================================
    // RENDER: INVENTORY + EQUIPMENT
    // =============================================================
    renderInventory() {
        const d = Panels.charFull;
        if (!d) return;
        const { inventory, equipment, slots, gold, effectiveStats: es } = d;

        let overlay = Panels._getOverlay();
        overlay.innerHTML = `
        <div style="display:flex;gap:20px;height:100%;max-width:900px;margin:0 auto">
            <!-- LEFT: Equipment Slots -->
            <div style="width:280px;flex-shrink:0">
                <div class="ph">🎽 EQUIPMENT</div>
                <div style="display:grid;gap:6px">
                    ${(slots || []).map(s => {
                        const eq = equipment.find(e => e.slot_key === s.slot_key);
                        return `<div class="eq-slot" onclick="${eq ? `Panels.unequip('${s.slot_key}')` : ''}" title="${eq ? 'Click to unequip' : 'Empty'}">
                            <span style="color:#666;font-size:10px;width:70px;display:inline-block">${s.name}</span>
                            ${eq ? `<span>${eq.icon || '📦'} <b>${eq.name}</b></span>
                                <span style="margin-left:auto;font-size:10px;color:#888">${Panels._statPreview(eq)}</span>`
                                : '<span style="color:#444">— empty —</span>'}
                        </div>`;
                    }).join('')}
                </div>
                <div style="margin-top:12px;padding:10px;background:rgba(255,255,255,0.03);border:1px solid #333;border-radius:6px">
                    <div style="font-size:10px;color:#666;margin-bottom:6px">EFFECTIVE STATS</div>
                    <div class="sg">${Panels._statGrid(es)}</div>
                </div>
            </div>

            <!-- RIGHT: Inventory Grid -->
            <div style="flex:1;overflow-y:auto">
                <div class="ph">📦 INVENTORY <span style="float:right;color:#ffaa00">💰 ${gold}g</span></div>
                ${inventory.length === 0 ? '<p style="color:#555;text-align:center;margin-top:40px">Inventory is empty.</p>' : `
                <div class="inv-grid">
                    ${inventory.map(item => `
                    <div class="inv-item" onclick="Panels.itemAction(${item.item_id}, '${Panels._esc(item.name)}', '${item.type}', '${item.slot || 'NONE'}')" title="${Panels._esc(item.description || '')}">
                        <div style="font-size:24px;text-align:center">${item.icon || '📦'}</div>
                        <div style="font-size:11px;color:#fff;text-align:center;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.name}</div>
                        <div style="font-size:10px;color:#888;text-align:center">${item.type}${item.quantity > 1 ? ` x${item.quantity}` : ''}</div>
                        ${item.type !== 'CONSUMABLE' && item.type !== 'MISC' && item.type !== 'KEY' ? `<div style="font-size:9px;color:#666;text-align:center">${Panels._statPreview(item)}</div>` : ''}
                    </div>`).join('')}
                </div>`}
            </div>
        </div>
        <div class="pk">[I] Close | Click item to equip/use | Click equipped item to unequip</div>`;
    },

    // =============================================================
    // RENDER: CHARACTER SHEET  (tabs: Overview / Stats / Skills / Progression)
    // =============================================================
    renderCharacter() {
        const d = Panels.charFull;
        if (!d) return;
        let overlay = Panels._getOverlay();
        overlay.innerHTML = Panels._charSheetHTML(d, 'overview');
    },

    _charSheetHTML(d, activeTab) {
        const c   = d.character;
        const es  = d.effectiveStats;
        const eq  = d.equipBonus;
        const pts = d.unspentPoints || 0;

        const tabs = [
            { key: 'overview',    icon: '🧙', label: 'Overview'    },
            { key: 'stats',       icon: '⚔️',  label: 'Stats'       },
            { key: 'skills',      icon: '✨',   label: 'Skills'      },
            { key: 'progression', icon: '📈',  label: 'Progression' },
        ];

        const tabBar = tabs.map(t => `
            <button class="cs-tab${t.key === activeTab ? ' cs-tab-active' : ''}"
                    onclick="Panels._charTabSwitch('${t.key}')">
                ${t.icon} ${t.label}${t.key === 'progression' && pts > 0
                    ? ` <span style="background:#bb86fc;color:#000;border-radius:8px;font-size:9px;padding:0 5px;margin-left:3px">${pts}</span>`
                    : ''}
            </button>`).join('');

        let content = '';
        switch (activeTab) {
            case 'overview':   content = Panels._csOverview(d, c, es); break;
            case 'stats':      content = Panels._csStats(c, es, eq);   break;
            case 'skills':     content = Panels._csSkills(d);          break;
            case 'progression':content = Panels._csProgression(d, c, es, pts); break;
        }

        return `
        <style>
        .cs-wrap    { max-width:700px; margin:0 auto; font-family:'Courier New',monospace; color:#e8eef6; }
        .cs-tabs    { display:flex; gap:4px; margin-bottom:16px; flex-wrap:wrap; }
        .cs-tab     { padding:8px 16px; border-radius:8px 8px 0 0; cursor:pointer; font-family:inherit;
                      font-size:12px; color:#666; background:rgba(255,255,255,0.04);
                      border:1px solid rgba(255,255,255,0.07); border-bottom:none; transition:.15s; }
        .cs-tab:hover { color:#aaa; }
        .cs-tab-active { color:#e8eef6; background:rgba(255,255,255,0.09); border-color:rgba(255,255,255,0.13); }
        .cs-card    { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; margin-bottom:10px; }
        .cs-sect    { color:#bb86fc; font-size:10px; text-transform:uppercase; letter-spacing:1px;
                      margin:14px 0 6px; border-bottom:1px solid #21262d; padding-bottom:4px; }
        .cs-stat-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
        .cs-stat-cell { background:rgba(255,255,255,0.03); border:1px solid #30363d; border-radius:7px;
                        padding:10px; text-align:center; }
        .cs-stat-key  { font-size:10px; color:#666; margin-bottom:4px; }
        .cs-stat-val  { font-size:22px; font-weight:bold; color:#e8eef6; }
        .cs-stat-bonus{ font-size:10px; color:#3fb950; }
        .cs-bar-row   { display:flex; align-items:center; gap:8px; margin-bottom:7px; }
        .cs-bar-lbl   { font-size:11px; width:28px; text-align:right; flex-shrink:0; }
        .cs-bar-track { flex:1; height:10px; background:rgba(255,255,255,0.07); border-radius:5px; overflow:hidden; }
        .cs-bar-fill  { height:100%; border-radius:5px; }
        .cs-bar-val   { font-size:11px; width:80px; text-align:right; flex-shrink:0; font-variant-numeric:tabular-nums; }
        .cs-skill-row { display:flex; align-items:center; gap:10px; padding:8px 10px;
                        background:rgba(255,255,255,0.02); border:1px solid #21262d; border-radius:6px; margin-bottom:5px; }
        .prog-row     { display:flex; align-items:center; gap:10px; padding:8px 12px;
                        background:rgba(255,255,255,0.02); border:1px solid #21262d; border-radius:6px; margin-bottom:6px; }
        .prog-key     { font-size:12px; color:#c9d1d9; width:90px; }
        .prog-val     { font-size:16px; font-weight:bold; color:#fff; width:40px; text-align:center; }
        .prog-btn     { width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:16px; font-weight:bold;
                        border:1px solid; transition:.15s; font-family:inherit; display:flex; align-items:center; justify-content:center; }
        .prog-btn-plus  { background:rgba(63,185,80,0.12); border-color:rgba(63,185,80,0.35); color:#3fb950; }
        .prog-btn-plus:hover  { background:rgba(63,185,80,0.25); }
        .prog-btn-minus { background:rgba(248,81,73,0.1);  border-color:rgba(248,81,73,0.3);  color:#f85149; }
        .prog-btn-minus:hover { background:rgba(248,81,73,0.2); }
        .prog-btn:disabled { opacity:.3; cursor:not-allowed; }
        .prog-commit  { padding:10px 24px; border-radius:8px; cursor:pointer; font-family:inherit; font-size:13px;
                        font-weight:700; background:rgba(63,185,80,0.15); border:1px solid rgba(63,185,80,0.4);
                        color:#3fb950; transition:.15s; }
        .prog-commit:hover:not(:disabled) { background:rgba(63,185,80,0.28); }
        .prog-commit:disabled { opacity:.35; cursor:not-allowed; }
        </style>
        <div class="cs-wrap">
            <div class="cs-tabs">${tabBar}</div>
            ${content}
        </div>
        <div class="pk">[C] or [ESC] Close</div>`;
    },

    // ── TAB: OVERVIEW ─────────────────────────────────────────────
    _csOverview(d, c, es) {
        let rec = { W:0, L:0, T:0 };
        try { rec = typeof c.battle_record === 'object' ? c.battle_record : JSON.parse(c.battle_record || '{}'); } catch {}

        const xpCur = d.xpCurrent || 0;
        const xpMax = d.xpToNext;
        const xpPct = xpMax ? Math.min(100, Math.round(xpCur / xpMax * 100)) : 100;
        const lb    = Math.min(100, Math.max(0, parseFloat(es.limitbreak || 0)));

        return `
        <div class="cs-card">
            <div style="display:flex;gap:16px;align-items:flex-start">
                <div style="flex:1">
                    <div style="font-size:22px;color:#ffcc00;font-weight:bold;margin-bottom:4px">${Panels._esc(c.name)}</div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
                        <span style="color:#bb86fc;font-size:12px">Lv. ${c.level}</span>
                        ${c.class_name ? `<span style="color:#03dac6;font-size:12px">${Panels._esc(c.class_name)}</span>` : ''}
                        ${c.race_name  ? `<span style="color:#9b59b6;font-size:12px">${Panels._esc(c.race_name)}</span>`  : ''}
                        ${c.bg_name    ? `<span style="color:#8b949e;font-size:12px">${Panels._esc(c.bg_name)}</span>`    : ''}
                    </div>
                </div>
                <div style="text-align:right">
                    <div style="color:#d29922;font-size:16px;font-weight:bold">💰 ${d.gold}g</div>
                    <div style="color:#3fb950;font-size:12px;margin-top:4px">⚔️ ${rec.W||0}W
                        <span style="color:#f85149">${rec.L||0}L</span>
                        <span style="color:#666">${rec.T||0}T</span>
                    </div>
                </div>
            </div>

            <!-- HP -->
            <div class="cs-bar-row">
                <div class="cs-bar-lbl" style="color:#e74c3c">HP</div>
                <div class="cs-bar-track">
                    <div class="cs-bar-fill" style="width:${Math.min(100,c.current_hp/es.maxHp*100)}%;background:linear-gradient(90deg,#c0392b,#e74c3c)"></div>
                </div>
                <div class="cs-bar-val" style="color:#e74c3c">${c.current_hp} / ${es.maxHp}</div>
            </div>

            <!-- MP -->
            <div class="cs-bar-row">
                <div class="cs-bar-lbl" style="color:#2e86c1">MP</div>
                <div class="cs-bar-track">
                    <div class="cs-bar-fill" style="width:${Math.min(100,c.current_mp/es.maxMp*100)}%;background:linear-gradient(90deg,#1a5276,#2e86c1)"></div>
                </div>
                <div class="cs-bar-val" style="color:#2e86c1">${c.current_mp} / ${es.maxMp}</div>
            </div>

            <!-- XP -->
            <div class="cs-bar-row">
                <div class="cs-bar-lbl" style="color:#bb86fc">XP</div>
                <div class="cs-bar-track">
                    <div class="cs-bar-fill" style="width:${xpPct}%;background:linear-gradient(90deg,#7d3c98,#bb86fc)"></div>
                </div>
                <div class="cs-bar-val" style="color:#9b59b6;font-size:10px">${xpMax ? `${xpCur} / ${xpMax}` : 'MAX'}</div>
            </div>

            <!-- Limit Break -->
            <div class="cs-bar-row">
                <div class="cs-bar-lbl" style="color:#f39c12">LB</div>
                <div class="cs-bar-track">
                    <div class="cs-bar-fill" style="width:${lb}%;background:linear-gradient(90deg,#b7770d,#f39c12)"></div>
                </div>
                <div class="cs-bar-val" style="color:#f39c12">${Math.floor(lb)}% (Lv.${es.breaklevel||1})</div>
            </div>
        </div>

        ${c.feat_name ? `<div class="cs-card">
            <div style="font-size:10px;color:#666;margin-bottom:4px">FEAT</div>
            <div style="color:#d29922;font-weight:bold">${Panels._esc(c.feat_name)}</div>
            ${c.feat_desc ? `<div style="color:#8b949e;font-size:12px;margin-top:3px">${Panels._esc(c.feat_desc)}</div>` : ''}
        </div>` : ''}`;
    },

    // ── TAB: STATS ────────────────────────────────────────────────
    _csStats(c, es, eq) {
        const statDefs = [
            { key:'atk',   label:'ATK',   desc:'Physical attack power',  color:'#e74c3c' },
            { key:'def',   label:'DEF',   desc:'Physical defense',        color:'#3498db' },
            { key:'mo',    label:'MO',    desc:'Magic offense',           color:'#9b59b6' },
            { key:'md',    label:'MD',    desc:'Magic defense',           color:'#1abc9c' },
            { key:'speed', label:'SPD',   desc:'Turn order & dodge',      color:'#f39c12' },
            { key:'luck',  label:'LCK',   desc:'Crit & bonus effects',    color:'#2ecc71' },
        ];

        const cells = statDefs.map(s => {
            const base  = c[s.key]    || 0;
            const bonus = eq[s.key]   || 0;
            const total = es[s.key]   || base;
            return `
            <div class="cs-stat-cell">
                <div class="cs-stat-key" style="color:${s.color}">${s.label}</div>
                <div class="cs-stat-val">${total}</div>
                <div style="font-size:10px;margin-top:2px">
                    <span style="color:#484f58">${base}</span>
                    ${bonus > 0 ? `<span class="cs-stat-bonus"> +${bonus}</span>` : ''}
                </div>
                <div style="font-size:9px;color:#484f58;margin-top:2px">${s.desc}</div>
            </div>`;
        }).join('');

        return `
        <div class="cs-card">
            <div style="color:#484f58;font-size:11px;margin-bottom:12px">
                Numbers shown as <span style="color:#8b949e">base</span>
                <span style="color:#3fb950">+gear</span> = <span style="color:#e8eef6">total</span>
            </div>
            <div class="cs-stat-grid">${cells}</div>
        </div>
        <div class="cs-card" style="display:flex;gap:24px;font-size:12px;color:#8b949e;justify-content:center">
            <span>MAX HP <b style="color:#e74c3c">${es.maxHp}</b></span>
            <span>MAX MP <b style="color:#2e86c1">${es.maxMp}</b></span>
        </div>`;
    },

    // ── TAB: SKILLS ───────────────────────────────────────────────
    _csSkills(d) {
        const skills  = d.skills  || [];
        const limits  = d.limits  || [];

        const skillRows = skills.length
            ? skills.map(s => `
            <div class="cs-skill-row">
                <span style="font-size:20px;width:30px;text-align:center">${s.icon || '✨'}</span>
                <div style="flex:1">
                    <div style="color:#aaccff;font-weight:bold;font-size:13px">${Panels._esc(s.alt_name || s.name)}</div>
                    ${s.description ? `<div style="color:#484f58;font-size:11px;margin-top:2px">${Panels._esc(s.description)}</div>` : ''}
                </div>
                <div style="text-align:right;flex-shrink:0">
                    <div style="color:#2e86c1;font-size:12px">${s.mp_cost} MP</div>
                    <div style="color:#484f58;font-size:10px">Lv.${s.learn_level} ${s.type || ''}</div>
                </div>
            </div>`).join('')
            : '<p style="color:#484f58;text-align:center;padding:20px">No skills learned yet.</p>';

        const limitRows = limits.length
            ? `<div class="cs-sect">⚡ Limit Breaks</div>` + limits.map(lb => `
            <div class="cs-skill-row">
                <span style="font-size:20px;width:30px;text-align:center">${lb.icon || '⚡'}</span>
                <div style="flex:1">
                    <div style="color:#f39c12;font-weight:bold;font-size:13px">${Panels._esc(lb.name)}</div>
                    ${lb.description ? `<div style="color:#484f58;font-size:11px;margin-top:2px">${Panels._esc(lb.description)}</div>` : ''}
                </div>
                <div style="text-align:right;flex-shrink:0">
                    <div style="color:#f39c12;font-size:11px">Break Lv.${lb.break_level||1}</div>
                    <div style="color:#484f58;font-size:10px">Req Lv.${lb.char_level_req||1}</div>
                </div>
            </div>`).join('')
            : '';

        return `<div class="cs-card">
            <div class="cs-sect">✨ Class Skills</div>
            ${skillRows}
            ${limitRows}
        </div>`;
    },

    // ── TAB: PROGRESSION ─────────────────────────────────────────
    _csProgression(d, c, es, pts) {
        // Build a local pending-spend object stored on Panels so +/- buttons work
        if (!Panels._progPending) {
            Panels._progPending = { atk:0, def:0, mo:0, md:0, speed:0, luck:0 };
        }
        const pend = Panels._progPending;
        const spent = Object.values(pend).reduce((a, b) => a + b, 0);
        const remaining = pts - spent;

        const statDefs = [
            { key:'atk',   label:'ATK — Attack',        color:'#e74c3c' },
            { key:'def',   label:'DEF — Defense',        color:'#3498db' },
            { key:'mo',    label:'MO — Magic Offense',   color:'#9b59b6' },
            { key:'md',    label:'MD — Magic Defense',   color:'#1abc9c' },
            { key:'speed', label:'SPD — Speed',          color:'#f39c12' },
            { key:'luck',  label:'LCK — Luck',           color:'#2ecc71' },
        ];

        const rows = statDefs.map(s => `
        <div class="prog-row">
            <div class="prog-key" style="color:${s.color}">${s.label}</div>
            <div class="prog-val" style="color:${s.color}">${(c[s.key]||0) + (d.equipBonus[s.key]||0)}</div>
            <div style="flex:1"></div>
            ${pend[s.key] > 0 ? `<span style="color:#3fb950;font-size:12px;min-width:28px">+${pend[s.key]}</span>` : '<span style="min-width:28px"></span>'}
            <button class="prog-btn prog-btn-minus" onclick="Panels._progAdj('${s.key}',-1)"
                    ${pend[s.key] <= 0 ? 'disabled' : ''}>−</button>
            <button class="prog-btn prog-btn-plus"  onclick="Panels._progAdj('${s.key}',+1)"
                    ${remaining <= 0 ? 'disabled' : ''}>+</button>
        </div>`).join('');

        return `
        <div class="cs-card">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
                <div>
                    <div style="font-size:18px;font-weight:bold;color:#bb86fc">${remaining}
                        <span style="font-size:12px;font-weight:normal;color:#666">points remaining</span>
                    </div>
                    ${spent > 0 ? `<div style="font-size:11px;color:#3fb950">${spent} staged to spend</div>` : ''}
                </div>
                ${pts <= 0 ? '<div style="color:#484f58;font-size:12px">Gain points by levelling up!</div>' : ''}
            </div>
            ${rows}
            <div style="margin-top:16px;display:flex;gap:10px">
                <button class="prog-commit" id="progCommitBtn"
                        onclick="Panels._progCommit()"
                        ${spent <= 0 ? 'disabled' : ''}>
                    ✅ Spend ${spent > 0 ? spent + ' Point' + (spent > 1 ? 's' : '') : 'Points'}
                </button>
                ${spent > 0 ? `<button onclick="Panels._progReset()"
                    style="padding:10px 16px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;
                    background:transparent;border:1px solid #484f58;color:#8b949e;transition:.15s"
                    onmouseover="this.style.borderColor='#f85149';this.style.color='#f85149'"
                    onmouseout="this.style.borderColor='#484f58';this.style.color='#8b949e'">
                    ✕ Reset
                </button>` : ''}
            </div>
        </div>`;
    },

    // Progression helpers — mutate pending and re-render the tab
    _progAdj(stat, delta) {
        if (!Panels._progPending) Panels._progPending = { atk:0, def:0, mo:0, md:0, speed:0, luck:0 };
        const pend  = Panels._progPending;
        const pts   = Panels.charFull?.unspentPoints || 0;
        const spent = Object.values(pend).reduce((a,b)=>a+b,0);
        if (delta > 0 && spent >= pts) return;
        pend[stat] = Math.max(0, (pend[stat] || 0) + delta);
        Panels.openCharacter('progression'); // re-render at progression tab
    },

    _progReset() {
        Panels._progPending = { atk:0, def:0, mo:0, md:0, speed:0, luck:0 };
        Panels.openCharacter('progression');
    },

    async _progCommit() {
        const pend  = Panels._progPending || {};
        const spend = {};
        Object.entries(pend).forEach(([k, v]) => { if (v > 0) spend[k] = v; });
        if (!Object.keys(spend).length) return;

        const r = await fetch('/api/progression/level-up', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: Game.userId, characterId: Game.myCharId, spend })
        });
        const j = await r.json();
        if (j.success) {
            showNotification(`✅ Stats upgraded! ${j.data.remaining_points} points left.`, 'item');
            Panels._progPending = null;
            await Panels.openCharacter('progression');
            loadCharData(); // refresh HUD bars
        } else {
            showNotification(j.error || 'Could not spend points', 'damage');
        }
    },

    // Tab switch (re-renders in place without re-fetching)
    async _charTabSwitch(tab) {
        if (!Panels.charFull) return;
        // Re-fetch if switching to progression to get fresh unspent count
        if (tab === 'progression') Panels._progPending = null;
        const overlay = document.getElementById('panelOverlay');
        if (overlay) overlay.innerHTML = Panels._charSheetHTML(Panels.charFull, tab);
    },

    // =============================================================
    // RENDER: SHOP
    // =============================================================
    renderShop() {
        const d = Panels.charFull;
        const s = Panels.shopData;
        if (!d || !s) return;

        let overlay = Panels._getOverlay();
        overlay.innerHTML = `
        <div style="max-width:750px;margin:0 auto">
            <div class="ph">🏪 ${s.shop.name} <span style="float:right;color:#ffaa00">💰 ${d.gold}g</span></div>
            ${s.shop.description ? `<p style="color:#666;font-size:12px;margin-bottom:12px">${s.shop.description}</p>` : ''}

            <!-- BUY TAB -->
            <div id="shopBuyTab" style="display:grid;gap:4px">
                ${s.supplies.map(item => {
                    const canBuy = d.gold >= item.buy_price;
                    return `<div class="shop-row">
                        <span style="font-size:18px;width:30px;text-align:center">${item.icon || '📦'}</span>
                        <div style="flex:1">
                            <div style="color:#fff;font-size:13px">${item.name}</div>
                            <div style="color:#666;font-size:10px">${item.type} ${item.slot && item.slot !== 'NONE' ? '• ' + item.slot : ''}</div>
                        </div>
                        <span style="color:#ffaa00;font-size:13px;width:60px;text-align:right">${item.buy_price}g</span>
                        <button onclick="Panels.buyItem(${item.item_id}, ${item.buy_price}, '${Panels._esc(item.name)}')"
                            style="margin-left:8px;padding:4px 12px;background:${canBuy ? '#004400' : '#222'};
                            border:1px solid ${canBuy ? '#00aa00' : '#333'};color:${canBuy ? '#00ff00' : '#555'};
                            cursor:${canBuy ? 'pointer' : 'not-allowed'};border-radius:4px;font-family:monospace;font-size:11px"
                            ${canBuy ? '' : 'disabled'}>BUY</button>
                    </div>`;
                }).join('')}
            </div>

            <!-- SELL SECTION -->
            <div class="ph" style="margin-top:16px;font-size:11px">SELL ITEMS</div>
            <div style="display:grid;gap:4px;max-height:200px;overflow-y:auto">
                ${d.inventory.filter(i => i.type !== 'KEY').map(item => {
                    const sellPrice = Math.floor((item.value || 0) * 0.5);
                    return `<div class="shop-row">
                        <span style="font-size:16px;width:24px;text-align:center">${item.icon || '📦'}</span>
                        <div style="flex:1">
                            <div style="color:#ccc;font-size:12px">${item.name} ${item.quantity > 1 ? `x${item.quantity}` : ''}</div>
                        </div>
                        <span style="color:#888;font-size:11px">${sellPrice}g</span>
                        <button onclick="Panels.sellItem(${item.item_id}, '${Panels._esc(item.name)}')"
                            style="margin-left:8px;padding:3px 10px;background:#220000;border:1px solid #660000;
                            color:#ff6666;cursor:pointer;border-radius:4px;font-family:monospace;font-size:11px">SELL</button>
                    </div>`;
                }).join('')}
                ${d.inventory.filter(i => i.type !== 'KEY').length === 0 ? '<p style="color:#555;text-align:center">Nothing to sell.</p>' : ''}
            </div>
        </div>
        <div class="pk">[ESC] Close Shop</div>`;
    },

    // =============================================================
    // ACTIONS
    // =============================================================
    async itemAction(itemId, name, type, slot) {
        if (type === 'CONSUMABLE') {
            // Use consumable item outside of battle
            // Teaching: We call /use-item which handles HP/MP restoration
            // and removes the item from inventory. The route was already built
            // in routes/game.js — this was the missing client-side call.
            if (!confirm(`Use ${name}?`)) return;
            const r = await fetch('/use-item', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId, itemId })
            });
            const j = await r.json();
            if (j.success) {
                showNotification(j.message || `Used ${name}`, j.hpRestored ? 'heal' : 'item');
                // Refresh HUD bars so HP/MP update immediately
                if (typeof loadCharData === 'function') loadCharData();
                await Panels.openInventory(); // Refresh inventory list
            } else {
                showNotification(j.message || 'Cannot use item.', 'damage');
            }
        } else if (slot && slot !== 'NONE') {
            // Equip
            const r = await fetch('/equip-item', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId, itemId, slotKey: slot })
            });
            const j = await r.json();
            if (j.success) {
                showNotification(`Equipped ${name}`, 'item');
                await Panels.openInventory(); // Refresh
            } else {
                showNotification(j.message || 'Cannot equip', 'damage');
            }
        }
    },

    async unequip(slotKey) {
        const r = await fetch('/unequip-item', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId, slotKey })
        });
        const j = await r.json();
        if (j.success) {
            showNotification('Unequipped', 'item');
            await Panels.openInventory();
        } else {
            showNotification(j.message || 'Error', 'damage');
        }
    },

    async buyItem(itemId, price, name) {
        if (!confirm(`Buy ${name} for ${price}g?`)) return;
        const r = await fetch('/buy-item', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId, shopId: Panels.shopId, itemId, quantity: 1 })
        });
        const j = await r.json();
        showNotification(j.message || (j.success ? 'Bought!' : 'Error'), j.success ? 'gold' : 'damage');
        if (j.success) await Panels.openShop(Panels.shopId); // Refresh
    },

    async sellItem(itemId, name) {
        if (!confirm(`Sell ${name}?`)) return;
        const r = await fetch('/sell-item', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId, itemId, quantity: 1 })
        });
        const j = await r.json();
        showNotification(j.message || (j.success ? 'Sold!' : 'Error'), j.success ? 'gold' : 'damage');
        if (j.success) await Panels.openShop(Panels.shopId);
    },

    // =============================================================
    // HELPERS
    // =============================================================
    _getOverlay() {
        let el = document.getElementById('panelOverlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'panelOverlay';
            el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;z-index:120;
                background:rgba(0,0,0,0.92);overflow-y:auto;padding:30px;font-family:'Courier New',monospace;color:#fff`;
            document.body.appendChild(el);
        }
        return el;
    },

    _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); },

    _statPreview(item) {
        const parts = [];
        if (item.bonus_atk) parts.push(`ATK+${item.bonus_atk}`);
        if (item.bonus_def) parts.push(`DEF+${item.bonus_def}`);
        if (item.bonus_mo) parts.push(`MO+${item.bonus_mo}`);
        if (item.bonus_md) parts.push(`MD+${item.bonus_md}`);
        if (item.bonus_speed) parts.push(`SPD+${item.bonus_speed}`);
        if (item.bonus_luck) parts.push(`LCK+${item.bonus_luck}`);
        if (item.bonus_hp) parts.push(`HP+${item.bonus_hp}`);
        if (item.bonus_mp) parts.push(`MP+${item.bonus_mp}`);
        return parts.join(' ') || '';
    },

    _statGrid(es) {
        return ['atk','def','mo','md','speed','luck'].map(k =>
            `<div style="display:flex;justify-content:space-between;padding:2px 0">
                <span style="color:#666;font-size:10px">${k.toUpperCase()}</span>
                <span style="color:#fff;font-size:11px;font-weight:bold">${es[k]}</span>
            </div>`
        ).join('');
    }
};
