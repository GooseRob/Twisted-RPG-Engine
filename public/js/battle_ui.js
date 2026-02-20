// =================================================================
// BATTLE UI v1.0 — Client-Side Combat Interface
// =================================================================
// Loaded by game_engine.js. Renders combat overlay on top of canvas.
// All logic is server-authoritative — this just shows menus and animations.

const BattleUI = {
    active: false,
    state: null,     // Current battle state from server
    commands: null,   // Available commands
    currentMenu: 'main', // main, skills, items

    // --- INITIALIZE FROM battle_start EVENT ---
    start(data) {
        BattleUI.active = true;
        BattleUI.state = data;
        BattleUI.commands = data.commands;
        BattleUI.currentMenu = 'main';
        Game.dialogueOpen = true; // Block movement
        BattleUI.render();
    },

    // --- UPDATE FROM battle_update EVENT ---
    update(data) {
        if (!BattleUI.active) return;
        if (data.state) BattleUI.state = { ...BattleUI.state, ...data.state };

        // Play action animations
        if (data.action && data.action.log) {
            data.action.log.forEach((msg, i) => {
                setTimeout(() => showNotification(msg, 'battle'), i * 400);
            });
        }

        // Check if battle ended
        if (BattleUI.state.status !== 'ACTIVE') {
            setTimeout(() => BattleUI.end(), 2000);
            return;
        }

        BattleUI.currentMenu = 'main';
        BattleUI.render();
    },

    // --- END BATTLE ---
    end() {
        BattleUI.active = false;
        Game.dialogueOpen = false;
        const overlay = document.getElementById('battleOverlay');
        if (overlay) overlay.remove();

        // Show result
        if (BattleUI.state) {
            const won = BattleUI.state.winner === Game.myCharId;
            const msg = BattleUI.state.status === 'FLED' ? '🏃 Escaped!' :
                        won ? '🏆 Victory!' : '💀 Defeated...';
            showNotification(msg, won ? 'quest_complete' : 'damage');
        }

        // Refresh character data
        loadCharData();
    },

    // --- RENDER ---
    render() {
        const s = BattleUI.state;
        if (!s) return;

        let overlay = document.getElementById('battleOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'battleOverlay';
            overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;z-index:150;
                background:rgba(0,0,0,0.85);display:flex;flex-direction:column;font-family:'Courier New',monospace;color:#fff`;
            document.body.appendChild(overlay);
        }

        const me = s.me;
        const opp = s.opponent;
        const isMyTurn = s.isMyTurn;
        const limitReady = me.limitbreak >= 100;

        overlay.innerHTML = `
        <!-- OPPONENT (top) -->
        <div style="padding:20px 40px;display:flex;justify-content:flex-end">
            <div style="width:350px;background:rgba(50,0,0,0.6);border:1px solid #600;padding:16px;border-radius:8px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <span style="font-size:18px;color:#ff6666;font-weight:bold">${opp.name}</span>
                    <span style="font-size:12px;color:#888">${BattleUI._statusIcons(opp.statuses)}</span>
                </div>
                <div style="margin-top:8px">
                    <div style="display:flex;align-items:center;gap:6px">
                        <span style="font-size:10px;color:#888;width:20px">HP</span>
                        <div style="flex:1;height:8px;background:#333;border-radius:4px;overflow:hidden">
                            <div style="width:${(opp.hp/opp.maxHp*100)}%;height:100%;background:linear-gradient(90deg,#ff3333,#ff6666);border-radius:4px;transition:width 0.5s"></div>
                        </div>
                        <span style="font-size:10px;color:#ff6666;width:60px;text-align:right">${opp.hp}/${opp.maxHp}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                        <span style="font-size:10px;color:#888;width:20px">MP</span>
                        <div style="flex:1;height:6px;background:#333;border-radius:3px;overflow:hidden">
                            <div style="width:${(opp.mp/opp.maxMp*100)}%;height:100%;background:linear-gradient(90deg,#3366ff,#6699ff);border-radius:3px"></div>
                        </div>
                        <span style="font-size:10px;color:#6699ff;width:60px;text-align:right">${opp.mp}/${opp.maxMp}</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- COMBAT ARENA (center) -->
        <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:100px">
            <div style="text-align:center">
                <div style="font-size:64px;animation:pulse 1s infinite">⚔️</div>
                <div style="color:#ffcc00;font-size:12px;margin-top:8px">Turn ${s.turn}</div>
                <div style="color:${isMyTurn?'#00ff00':'#ff6666'};font-size:14px;font-weight:bold;margin-top:4px">
                    ${isMyTurn ? 'YOUR TURN' : 'WAITING...'}
                </div>
            </div>
        </div>

        <!-- PLAYER (bottom) -->
        <div style="padding:0 40px 20px;display:flex;gap:20px">
            <!-- Player Stats -->
            <div style="width:350px;background:rgba(0,30,0,0.6);border:1px solid #060;padding:16px;border-radius:8px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <span style="font-size:18px;color:#00ff66;font-weight:bold">${me.name}</span>
                    <span style="font-size:12px;color:#888">${BattleUI._statusIcons(me.statuses)}</span>
                </div>
                <div style="margin-top:8px">
                    <div style="display:flex;align-items:center;gap:6px">
                        <span style="font-size:10px;color:#888;width:20px">HP</span>
                        <div style="flex:1;height:10px;background:#333;border-radius:5px;overflow:hidden">
                            <div style="width:${(me.hp/me.maxHp*100)}%;height:100%;background:linear-gradient(90deg,#00cc00,#00ff66);border-radius:5px;transition:width 0.5s"></div>
                        </div>
                        <span style="font-size:11px;color:#00ff66;width:70px;text-align:right">${me.hp}/${me.maxHp}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                        <span style="font-size:10px;color:#888;width:20px">MP</span>
                        <div style="flex:1;height:8px;background:#333;border-radius:4px;overflow:hidden">
                            <div style="width:${(me.mp/me.maxMp*100)}%;height:100%;background:linear-gradient(90deg,#3366ff,#6699ff);border-radius:4px"></div>
                        </div>
                        <span style="font-size:11px;color:#6699ff;width:70px;text-align:right">${me.mp}/${me.maxMp}</span>
                    </div>
                    <!-- Limit Bar -->
                    <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                        <span style="font-size:10px;color:#888;width:20px">LB</span>
                        <div style="flex:1;height:6px;background:#333;border-radius:3px;overflow:hidden">
                            <div style="width:${me.limitbreak||0}%;height:100%;background:linear-gradient(90deg,#ff6600,#ffcc00);border-radius:3px;${limitReady?'animation:glow 0.5s infinite alternate':''}"></div>
                        </div>
                        <span style="font-size:10px;color:#ffcc00;width:40px;text-align:right">${Math.floor(me.limitbreak||0)}%</span>
                    </div>
                </div>
            </div>

            <!-- Command Menu -->
            <div style="flex:1;background:rgba(0,0,0,0.7);border:1px solid #444;padding:16px;border-radius:8px;max-height:200px;overflow-y:auto">
                ${isMyTurn ? BattleUI._renderMenu() : '<div style="text-align:center;color:#666;padding:20px">Waiting for opponent...</div>'}
            </div>

            <!-- Combat Log -->
            <div style="width:250px;background:rgba(0,0,0,0.5);border:1px solid #333;padding:12px;border-radius:8px;max-height:200px;overflow-y:auto;font-size:11px">
                <div style="color:#666;margin-bottom:4px;font-weight:bold">COMBAT LOG</div>
                ${(s.log || []).slice(-8).map(l =>
                    `<div style="color:#aaa;margin:2px 0;border-bottom:1px solid #222;padding:2px 0">${l.text || l.action || ''}</div>`
                ).join('')}
            </div>
        </div>

        <style>
            @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.1)} }
            @keyframes glow { from{box-shadow:0 0 4px #ffcc00} to{box-shadow:0 0 12px #ff6600} }
        </style>`;
    },

    // --- RENDER COMMAND MENU ---
    _renderMenu() {
        const cmds = BattleUI.commands;
        if (!cmds) return '';

        if (BattleUI.currentMenu === 'skills') {
            return BattleUI._renderSkillMenu(cmds.skills);
        }
        if (BattleUI.currentMenu === 'items') {
            return BattleUI._renderItemMenu(cmds.items);
        }
        if (BattleUI.currentMenu === 'limits') {
            return BattleUI._renderLimitMenu(cmds.limits);
        }

        // Main command buttons
        let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
        for (const cmd of cmds.commands) {
            const isMenu = cmd.name === 'Skills' || cmd.name === 'Items';
            const onclick = isMenu
                ? `BattleUI.currentMenu='${cmd.name.toLowerCase()}';BattleUI.render()`
                : `BattleUI.sendAction({commandId:${cmd.id}})`;
            html += `<button onclick="${onclick}" ${cmd.disabled ? 'disabled' : ''}
                style="padding:12px;background:${cmd.disabled?'#222':'#1a1a1a'};border:1px solid ${cmd.disabled?'#333':'#555'};
                color:${cmd.disabled?'#555':'#fff'};cursor:${cmd.disabled?'not-allowed':'pointer'};border-radius:6px;
                font-family:monospace;font-size:14px;text-align:left;transition:0.2s"
                onmouseover="this.style.background='${cmd.disabled?'#222':'#333'}'" onmouseout="this.style.background='${cmd.disabled?'#222':'#1a1a1a'}'">
                ${cmd.icon} ${cmd.name}
            </button>`;
        }

        // Limit break button (if bar is full)
        const s = BattleUI.state;
        if (s && s.me.limitbreak >= 100 && cmds.limits && cmds.limits.length) {
            html += `<button onclick="BattleUI.currentMenu='limits';BattleUI.render()"
                style="padding:12px;background:#330000;border:2px solid #ff6600;color:#ffcc00;cursor:pointer;
                border-radius:6px;font-family:monospace;font-size:14px;text-align:left;animation:glow 0.5s infinite alternate">
                💥 LIMIT BREAK
            </button>`;
        }

        html += '</div>';
        return html;
    },

    _renderSkillMenu(skills) {
        if (!skills || !skills.length) return '<p style="color:#666">No skills learned yet.</p>' + BattleUI._backBtn();
        let html = '<div style="font-size:12px;color:#888;margin-bottom:8px">SKILLS</div><div style="display:grid;gap:6px">';
        const me = BattleUI.state.me;
        for (const sk of skills) {
            const canUse = me.mp >= sk.mpCost;
            html += `<button onclick="BattleUI.sendAction({skillId:${sk.id}})" ${canUse?'':'disabled'}
                style="padding:8px 12px;background:${canUse?'#1a1a2a':'#1a1a1a'};border:1px solid ${canUse?'#4466aa':'#333'};
                color:${canUse?'#aaccff':'#555'};cursor:${canUse?'pointer':'not-allowed'};border-radius:4px;
                font-family:monospace;font-size:12px;text-align:left">
                ${sk.icon} ${sk.name} <span style="float:right;color:${canUse?'#6699ff':'#444'}">${sk.mpCost} MP</span>
            </button>`;
        }
        html += '</div>' + BattleUI._backBtn();
        return html;
    },

    _renderItemMenu(items) {
        if (!items || !items.length) return '<p style="color:#666">No usable items.</p>' + BattleUI._backBtn();
        let html = '<div style="font-size:12px;color:#888;margin-bottom:8px">ITEMS</div><div style="display:grid;gap:6px">';
        for (const it of items) {
            html += `<button onclick="BattleUI.sendAction({itemId:${it.id}})"
                style="padding:8px 12px;background:#1a1a1a;border:1px solid #555;color:#fff;cursor:pointer;
                border-radius:4px;font-family:monospace;font-size:12px;text-align:left">
                ${it.icon} ${it.name} <span style="float:right;color:#888">x${it.quantity}</span>
            </button>`;
        }
        html += '</div>' + BattleUI._backBtn();
        return html;
    },

    _renderLimitMenu(limits) {
        if (!limits || !limits.length) return '<p style="color:#666">No limit breaks available.</p>' + BattleUI._backBtn();
        let html = '<div style="font-size:12px;color:#ffcc00;margin-bottom:8px">💥 LIMIT BREAKS</div><div style="display:grid;gap:6px">';
        for (const lb of limits) {
            html += `<button onclick="BattleUI.sendAction({limitId:${lb.id}})"
                style="padding:10px 12px;background:#330000;border:2px solid #ff6600;color:#ffcc00;cursor:pointer;
                border-radius:4px;font-family:monospace;font-size:13px;text-align:left">
                ${lb.icon} ${lb.name} <span style="float:right;font-size:10px;color:#ff8800">Lv${lb.breakLevel}</span>
            </button>`;
        }
        html += '</div>' + BattleUI._backBtn();
        return html;
    },

    _backBtn() {
        return `<button onclick="BattleUI.currentMenu='main';BattleUI.render()"
            style="margin-top:8px;padding:6px;background:#222;border:1px solid #444;color:#888;cursor:pointer;
            border-radius:4px;font-family:monospace;font-size:11px;width:100%">← BACK</button>`;
    },

    _statusIcons(statuses) {
        if (!statuses || !statuses.length) return '';
        return statuses.map(s => `<span title="${s.name} (${s.turns}t)">${s.icon||'⚡'}</span>`).join(' ');
    },

    // --- SEND ACTION TO SERVER ---
    sendAction(action) {
        if (!BattleUI.state || !BattleUI.state.isMyTurn) return;
        Game.socket.emit('battle_action', {
            battleId: BattleUI.state.battleId,
            ...action
        });
        // Disable menu until server responds
        BattleUI.state.isMyTurn = false;
        BattleUI.render();
    }
};
