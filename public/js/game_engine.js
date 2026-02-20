// =================================================================
// TWISTED GAME ENGINE — CLIENT v5.1 (Dialogue, State & HP/MP Bars)
// =================================================================
const TILE_SIZE = 32;
const CANVAS = document.getElementById('gameCanvas');
const CTX = CANVAS.getContext('2d');
const COLORS = ['#228822', '#888888', '#2222FF', '#442200'];
const BLOCKED_TILES = [1, 2];
const EVENT_ICONS = { TELEPORT: '🚪', NPC: '👤', ENEMY: '💀', LOOT: '💎', SHOP: '🏪' };

const Game = {
    socket: io(),
    userId: localStorage.getItem('twisted_id'),
    myCharId: null,
    myHero: null,
    players: {},
    map: { id: 0, name: 'Loading...', width: 20, height: 20, tiles: Array(400).fill(0), events: [] },
    state: {},
    dialogueOpen: false,
    charData: null // Full character data for HP/MP display
};

function init() {
    const p = new URLSearchParams(window.location.search);
    const id = p.get('id');
    if (id) Game.myCharId = parseInt(id, 10);
    else { alert('No character selected.'); window.location.href = '/'; return; }

    // PATCH #1 (client half): Always send userId so the server can verify character ownership.
    if (!Game.userId) {
        alert('You are not logged in. Please log in again.');
        window.location.href = '/';
        return;
    }
    Game.socket.emit('join_game', { charId: Game.myCharId, userId: Game.userId });
    requestAnimationFrame(gameLoop);
}

// --- NETWORK ---
Game.socket.on('error_msg', (msg) => alert(String(msg)));

Game.socket.on('init_self', (data) => {
    Game.players[data.charId] = data;
    Game.myHero = Game.players[data.charId];
    document.getElementById('charName').innerText = data.name;
    loadMap(data.mapId);
    loadState();
    loadCharData();
    // Initialize chat — pass staff status so admin tab shows/hides correctly
    const STAFF_ROLES = ['ADMIN', 'GM', 'MOD', 'STAFF', 'OWNER'];
    const isStaff = STAFF_ROLES.includes((data.role || '').toUpperCase());
    if (typeof ChatUI    !== 'undefined') ChatUI.init(isStaff);
    // Initialize minimap canvas overlay
    if (typeof MinimapUI !== 'undefined') MinimapUI.init();
    // Initialize nearby players panel (wires into playerCount click)
    if (typeof NearbyUI  !== 'undefined') NearbyUI.init();
    // Wire party real-time socket events
    if (typeof PartyUI   !== 'undefined') PartyUI.initSockets();
    // Wire guild real-time socket events
    if (typeof GuildUI   !== 'undefined') GuildUI.initSockets();
    // Wire trade real-time socket events
    if (typeof TradeUI   !== 'undefined') TradeUI.initSockets();
});

Game.socket.on('player_list', (list) => {
    // Teaching: player_list arrives both on login AND after a teleport.
    // We rebuild the players map from scratch. If myHero is in the list
    // we update its position too (server is authoritative).
    Game.players = {};
    list.forEach(p => Game.players[p.charId] = p);
    // Keep our own hero entry — server excludes us from the post-teleport list
    // (so we don't overwrite the position map_changed already set)
    if (!Game.players[Game.myCharId] && Game.myHero) {
        Game.players[Game.myCharId] = Game.myHero;
    }
    Game.myHero = Game.players[Game.myCharId] || Game.myHero;
    updatePlayerCount();
    // Notify nearby players panel if it exists
    if (typeof NearbyUI !== 'undefined') NearbyUI.refresh();
});

// --- MAP CHANGED (fires after teleport / fast travel) ---
// Teaching: This event is the client-side trigger to reload map tiles.
// The server emits it right after a teleport succeeds, BEFORE player_list,
// so we can clear the old canvas immediately. We do an async fetch to /get-map,
// update Game.map and Game.myHero position, then the game loop draws the new tiles.
Game.socket.on('map_changed', async ({ mapId, mapName, x, y }) => {
    // Update hero position immediately — don't wait for the REST fetch
    if (Game.myHero) {
        Game.myHero.x       = x;
        Game.myHero.y       = y;
        Game.myHero.mapId   = mapId;
    }
    // Update the map name display right away (optimistic)
    if (mapName) {
        const nameEl = document.getElementById('mapName');
        if (nameEl) nameEl.innerText = mapName;
    }
    updateCoordsUI();
    // Now fetch the full tile data
    await loadMap(mapId);
    // Minimap picks up the new map automatically since it reads Game.map each frame
});

Game.socket.on('player_moved', (d) => { if (Game.players[d.id]) { Game.players[d.id].x = d.x; Game.players[d.id].y = d.y; } });
Game.socket.on('player_joined', (p) => {
    Game.players[p.charId] = p;
    updatePlayerCount();
    if (typeof NearbyUI !== 'undefined') NearbyUI.refresh();
});
Game.socket.on('player_left', (id) => {
    delete Game.players[id];
    updatePlayerCount();
    if (typeof NearbyUI !== 'undefined') NearbyUI.refresh();
});
Game.socket.on('force_move', (pos) => { if (Game.myHero) { Game.myHero.x = pos.x; Game.myHero.y = pos.y; updateCoordsUI(); } });

// --- NPC DIALOGUE ---
Game.socket.on('npc_reply', (payload) => openDialogue(payload.npcName, payload.text));

// --- EVENT QUEUE PLAYER ---
// The server sends an array of commands. We play them back sequentially.
// This is the client-side half of the Event Runner.
Game.socket.on('event_queue', (queue) => {
    if (!queue || !Array.isArray(queue)) return;
    playEventQueue([...queue]);
});

function playEventQueue(queue) {
    if (queue.length === 0) return;
    const cmd = queue.shift();

    switch (cmd.cmd) {
        case 'dialogue':
            openDialogue(cmd.speaker, cmd.text);
            // Wait for player to dismiss, then continue queue
            Game._pendingQueue = queue;
            return; // closeDialogue() will resume

        case 'choice':
            showChoiceUI(cmd.prompt, cmd.options);
            Game._pendingQueue = queue;
            return; // choice click will resume

        case 'teleport':
            Game.socket.emit('teleport', { mapId: cmd.mapId, x: cmd.x, y: cmd.y });
            loadMap(cmd.mapId);
            playEventQueue(queue);
            break;

        case 'notification':
            showNotification(cmd.text, cmd.type);
            playEventQueue(queue);
            break;

        case 'npc_talk_prompt': {
            // Server wants us to prompt for NPC chat (LLM mode)
            const lastEv = Game.map.events.find(e => e.data === cmd.npcName && e.type === 'NPC');
            const msg = prompt(`Talk to ${cmd.npcName}:`);
            if (msg && lastEv) {
                Game.socket.emit('npc_talk', { x: lastEv.x, y: lastEv.y, message: msg });
            }
            playEventQueue(queue);
            break;
        }

        case 'open_shop':
            Panels.openShop(cmd.shopId);
            Game._pendingQueue = queue;
            return;

        case 'offer_quest':
            // Teaching: The server's event_runner found an OFFER_QUEST action.
            // This shows the player a styled accept/decline popup for a quest.
            // If accepted, we call the REST endpoint to accept it,
            // then refresh the quest log so they see it in their Active tab.
            (function(cmd) {
                const n = document.createElement('div');
                n.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                    background:rgba(5,8,14,0.97);border:1px solid rgba(187,134,252,0.4);border-radius:12px;
                    padding:20px 24px;z-index:200;color:#e8eef6;min-width:340px;max-width:480px;`;
                n.innerHTML = `
                    <div style="color:#bb86fc;font-weight:bold;font-size:15px;margin-bottom:4px">📜 New Quest</div>
                    <div style="font-size:18px;font-weight:bold;color:#e8eef6;margin-bottom:8px">${_escHtml(cmd.questTitle || 'Quest')}</div>
                    ${cmd.questDesc ? `<div style="color:#8b949e;font-size:12px;margin-bottom:12px">${_escHtml(cmd.questDesc)}</div>` : ''}
                    ${cmd.rewards ? `<div style="color:#f39c12;font-size:11px;margin-bottom:12px">🏆 Rewards: ${_escHtml(cmd.rewards)}</div>` : ''}
                    <div style="display:flex;gap:10px">
                        <button id="offerQuestAccept"
                            style="flex:1;padding:9px;background:rgba(187,134,252,0.15);border:1px solid rgba(187,134,252,0.4);
                            color:#bb86fc;cursor:pointer;border-radius:7px;font-size:13px;font-family:'Courier New',monospace;font-weight:bold">
                            ✅ Accept</button>
                        <button onclick="this.closest('[style]').remove();Game.dialogueOpen=false;"
                            style="flex:1;padding:9px;background:rgba(255,255,255,0.04);border:1px solid #30363d;
                            color:#8b949e;cursor:pointer;border-radius:7px;font-size:13px;font-family:'Courier New',monospace">
                            Decline</button>
                    </div>`;
                document.body.appendChild(n);
                document.getElementById('offerQuestAccept').addEventListener('click', async () => {
                    n.remove();
                    Game.dialogueOpen = false;
                    try {
                        const r = await fetch('/api/quests/accept', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: Game.userId, characterId: Game.myCharId, questId: cmd.questId })
                        }).then(res => res.json());
                        if (r.success) {
                            showNotification(`📜 Quest Accepted: ${cmd.questTitle}`, 'quest');
                            if (typeof QuestUI !== 'undefined') QuestUI.load();
                            if (typeof updateQuestTracker === 'function') updateQuestTracker();
                        } else {
                            showNotification(r.message || 'Could not accept quest.', 'damage');
                        }
                    } catch (e) {
                        showNotification('Error accepting quest.', 'damage');
                    }
                });
                Game.dialogueOpen = true;
            })(cmd);
            playEventQueue(queue);
            return;

        case 'start_battle':
            showNotification('⚔️ Battle starting!', 'battle');
            // TODO: Hook into battle engine
            playEventQueue(queue);
            break;

        case 'sound':
            // TODO: Play audio file when audio system is built
            playEventQueue(queue);
            break;

        case 'screen_effect':
            doScreenEffect(cmd.effect, cmd.duration);
            playEventQueue(queue);
            break;

        case 'wait':
            setTimeout(() => playEventQueue(queue), cmd.ms || 1000);
            return;

        default:
            console.warn('Unknown event cmd:', cmd.cmd);
            playEventQueue(queue);
    }
}

// --- CHOICE UI ---
function showChoiceUI(prompt, options) {
    Game.dialogueOpen = true;
    const box = document.getElementById('dialogueBox');
    box.style.display = 'block';
    document.getElementById('npcName').innerText = prompt || 'Choose';
    let html = '';
    options.forEach((opt, i) => {
        html += `<div onclick="pickChoice(${opt.id})" style="cursor:pointer;padding:10px;margin:5px 0;
            background:#1a1a1a;border:1px solid #555;color:#ffcc00;font-size:14px;
            transition:0.2s" onmouseover="this.style.background='#333'" onmouseout="this.style.background='#1a1a1a'">
            ${i + 1}. ${opt.label}</div>`;
    });
    document.getElementById('npcText').innerHTML = html;
    document.getElementById('npcInstructions').innerText = '[CLICK AN OPTION]';
}

function pickChoice(optionId) {
    closeDialogue();
    Game.socket.emit('event_choice', { optionId });
}

// --- NOTIFICATION SYSTEM ---
function showNotification(text, type) {
    const n = document.createElement('div');
    n.innerText = text;
    const colors = { item: '#ffcc00', gold: '#ffaa00', xp: '#00ff88', quest: '#bb86fc', quest_complete: '#ff66ff', heal: '#00ff66', damage: '#ff3333', battle: '#ff0000' };
    n.style.cssText = `position:fixed;top:${80 + (document.querySelectorAll('.notif').length * 40)}px;right:20px;
        background:rgba(0,0,0,0.85);color:${colors[type] || '#fff'};padding:10px 20px;
        border:1px solid ${colors[type] || '#444'};border-radius:6px;font-family:monospace;
        font-size:14px;z-index:200;animation:slideIn 0.3s ease;pointer-events:none`;
    n.className = 'notif';
    document.body.appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity 0.5s'; }, 2500);
    setTimeout(() => n.remove(), 3000);
}

// --- BATTLE SOCKET HANDLERS ---
Game.socket.on('battle_start', (data) => BattleUI.start(data));
Game.socket.on('battle_update', (data) => {
    // Server sends per-charId updates — only process ours
    if (data.forCharId && data.forCharId !== Game.myCharId) return;
    BattleUI.update(data);
});
Game.socket.on('battle_error', (msg) => showNotification('⚠️ ' + msg, 'damage'));
Game.socket.on('battle_challenged', (data) => {
    // Teaching: Never use browser confirm() for real-time events —
    // it blocks the entire JS thread which also blocks socket.io heartbeats,
    // causing disconnects if the player takes too long to decide.
    // Instead we show a styled in-page toast with Accept/Decline buttons.
    const n = document.createElement('div');
    n.id = 'pvpChallengeToast';
    n.style.cssText = `position:fixed;top:80px;left:50%;transform:translateX(-50%);
        background:rgba(5,8,14,0.97);border:1px solid rgba(248,81,73,0.6);border-radius:12px;
        padding:16px 24px;z-index:200;color:#e8eef6;font-size:14px;text-align:center;
        box-shadow:0 0 20px rgba(248,81,73,0.2);min-width:300px;`;
    n.innerHTML = `
        <div style="color:#f85149;font-weight:bold;font-size:16px;margin-bottom:8px">⚔️ PvP CHALLENGE</div>
        <div style="color:#c9d1d9;margin-bottom:14px"><b>${_escHtml(data.challengerName)}</b> challenges you to battle!</div>
        <div style="display:flex;gap:10px;justify-content:center">
            <button onclick="Game.socket.emit('battle_accept',{challengerCharId:${data.challengerCharId}});document.getElementById('pvpChallengeToast')?.remove()"
                style="padding:8px 20px;background:rgba(248,81,73,0.2);border:1px solid #f85149;color:#f85149;
                cursor:pointer;border-radius:7px;font-size:13px;font-weight:bold;font-family:'Courier New',monospace">
                ⚔️ Fight!</button>
            <button onclick="document.getElementById('pvpChallengeToast')?.remove()"
                style="padding:8px 20px;background:rgba(255,255,255,0.05);border:1px solid #30363d;color:#8b949e;
                cursor:pointer;border-radius:7px;font-size:13px;font-family:'Courier New',monospace">
                Decline</button>
        </div>`;
    // Remove old toast if one exists
    document.getElementById('pvpChallengeToast')?.remove();
    document.body.appendChild(n);
    // Auto-dismiss after 20 seconds if no action taken
    setTimeout(() => n.remove(), 20000);
});

// Random encounters
Game.socket.on('random_encounter', (data) => {
    showNotification(`👹 ${data.zoneName}: ${data.npcName} appears!`, 'battle');
    Game.socket.emit('start_pve_battle', { enemyCharId: data.npcId });
});

// --- SCREEN EFFECTS ---
function doScreenEffect(effect, duration) {
    const canvas = document.getElementById('gameCanvas');
    if (effect === 'shake') {
        let t = 0;
        const interval = setInterval(() => {
            canvas.style.transform = `translate(${(Math.random()-0.5)*8}px, ${(Math.random()-0.5)*8}px)`;
            t += 50;
            if (t >= duration) { clearInterval(interval); canvas.style.transform = ''; }
        }, 50);
    } else if (effect === 'flash') {
        canvas.style.filter = 'brightness(3)';
        setTimeout(() => { canvas.style.filter = ''; }, duration);
    } else if (effect === 'fade') {
        canvas.style.opacity = '0';
        canvas.style.transition = `opacity ${duration}ms`;
        setTimeout(() => { canvas.style.opacity = '1'; }, duration);
    }
}

function openDialogue(name, text) {
    Game.dialogueOpen = true;
    document.getElementById('dialogueBox').style.display = 'block';
    document.getElementById('npcName').innerText = name;
    document.getElementById('npcText').innerText = text;
}
function closeDialogue() {
    Game.dialogueOpen = false;
    document.getElementById('dialogueBox').style.display = 'none';
    // Resume event queue if there are more actions waiting
    if (Game._pendingQueue && Game._pendingQueue.length > 0) {
        const q = Game._pendingQueue;
        Game._pendingQueue = null;
        setTimeout(() => playEventQueue(q), 100);
    }
}

// --- STATE ---
async function loadState() {
    try {
        const r = await fetch('/load-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ charId: Game.myCharId, userId: Game.userId }) });
        const j = await r.json();
        if (j.success) Game.state = j.state || {};
    } catch (e) { console.error('State load failed:', e); }
}
async function saveState() {
    await fetch('/save-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ charId: Game.myCharId, userId: Game.userId, state: Game.state }) });
}

// --- CHARACTER DATA (HP/MP/XP/LB bars) ---
// Teaching: We used to call /my-characters here (lightweight) but it has no XP,
// limit-break, or class data. Now we call /get-char-full which returns everything.
// This is a slightly heavier call but means all bars always have real data.
async function loadCharData() {
    try {
        const r = await fetch('/get-char-full', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: Game.userId, charId: Game.myCharId })
        });
        const j = await r.json();
        if (j.success) {
            // Store in two places: lightweight charData (legacy) and full charFull
            Game.charFull = j;
            Game.charData = j.character;
            updateBars(j);
            updateQuestTracker();
        }
    } catch (e) { console.error('loadCharData error:', e); }
}

function updateBars(data) {
    // data is the full /get-char-full response; fall back to Game.charFull if not passed
    const d = data || Game.charFull;
    if (!d) return;
    const c = d.character;
    const es = d.effectiveStats;

    // HP
    const hp = Math.max(0, c.current_hp), mhp = es.maxHp || 1;
    const hpPct = Math.min(100, hp / mhp * 100);
    document.getElementById('hpFill').style.width = hpPct + '%';
    document.getElementById('hpVal').innerText = hp + ' / ' + mhp;

    // MP
    const mp = Math.max(0, c.current_mp), mmp = es.maxMp || 1;
    document.getElementById('mpFill').style.width = Math.min(100, mp / mmp * 100) + '%';
    document.getElementById('mpVal').innerText = mp + ' / ' + mmp;

    // XP bar — xpCurrent and xpToNext come from get-char-full
    const xpCur = d.xpCurrent || 0;
    const xpMax = d.xpToNext;
    if (xpMax) {
        document.getElementById('xpFill').style.width = Math.min(100, xpCur / xpMax * 100) + '%';
        document.getElementById('xpVal').innerText = xpCur + ' / ' + xpMax;
    } else {
        document.getElementById('xpFill').style.width = '100%';
        document.getElementById('xpVal').innerText = 'MAX';
    }

    // Limit Break bar (limitbreak is a 0-100 float stored on the character)
    const lb = Math.min(100, Math.max(0, parseFloat(es.limitbreak || 0)));
    document.getElementById('lbFill').style.width = lb + '%';
    document.getElementById('lbVal').innerText = Math.floor(lb) + '%';

    // Level badge
    document.getElementById('hudLevel').innerText = 'Lv. ' + c.level;
}

// --- MINI QUEST TRACKER (HUD widget below main bars) ---
// Teaching: This pulls from QuestUI's already-loaded data so we don't make an
// extra network call — QuestUI.activeQuests is populated whenever the quest log
// is opened or when loadCharData runs (we call updateQuestTracker after refresh).
function updateQuestTracker() {
    const tracker = document.getElementById('questTracker');
    const body    = document.getElementById('qtBody');
    const more    = document.getElementById('qtMore');
    if (!tracker || !body) return;

    // Position tracker below the HUD
    const hud = document.getElementById('hud');
    if (hud) {
        const hudBottom = hud.getBoundingClientRect().bottom;
        tracker.style.top = (hudBottom + 8) + 'px';
    }

    const activeQuests = (typeof QuestUI !== 'undefined') ? QuestUI.activeQuests : {};
    const keys = Object.keys(activeQuests || {});

    if (!keys.length) { tracker.style.display = 'none'; return; }

    tracker.style.display = 'block';
    const first = activeQuests[keys[0]];
    const objs  = first.objectives || {};
    const objKeys = Object.keys(objs);

    // Show up to 3 objectives in the tracker
    const shown = objKeys.slice(0, 3);
    body.innerHTML = `<div class="qt-name">${_escHtml(first.title || keys[0])}</div>`
        + shown.map(k => {
            const o = objs[k];
            const pct = o.target > 0 ? Math.min(100, Math.round(o.current / o.target * 100)) : 100;
            return `<div class="qt-obj${o.complete ? ' done' : ''}">
                <span>${o.complete ? '✅' : '⬜'}</span>
                <div class="qt-track"><div class="qt-fill" style="width:${pct}%"></div></div>
                <span style="white-space:nowrap">${o.current}/${o.target}</span>
            </div>`;
        }).join('');

    // Show "N more quests / M more objectives" hint
    const extraObjs  = objKeys.length - shown.length;
    const extraQuests = keys.length - 1;
    const hints = [];
    if (extraObjs > 0)   hints.push(`+${extraObjs} more objective${extraObjs > 1 ? 's' : ''}`);
    if (extraQuests > 0) hints.push(`+${extraQuests} more quest${extraQuests > 1 ? 's' : ''}`);
    more.innerText = hints.join('  ');
}

function _escHtml(s) { return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// --- MAP ---
async function loadMap(mapId) {
    try {
        const r = await fetch('/get-map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapId }) });
        const j = await r.json();
        if (j.success) {
            Game.map = j.map;
            if (!Array.isArray(Game.map.tiles)) Game.map.tiles = Array(400).fill(0);
            if (!Array.isArray(Game.map.events)) Game.map.events = [];
            document.getElementById('mapName').innerText = Game.map.name;
        }
    } catch (e) { console.error(e); }
}

// --- INPUT ---
window.addEventListener('keydown', (e) => {
    // CRITICAL: If player is typing in any input/textarea, block all game hotkeys.
    // This prevents WASD from moving the character while typing in chat.
    if (document.activeElement &&
        (document.activeElement.tagName === 'INPUT' ||
         document.activeElement.tagName === 'TEXTAREA')) return;

    // Panel hotkeys (work even when dialogue is open, to toggle panels)
    if (e.key === 'i' || e.key === 'I') {
        if (Panels.open === 'inventory') { Panels.close(); return; }
        if (!Panels.open && !BattleUI.active) { Panels.openInventory(); return; }
    }
    if (e.key === 'c' || e.key === 'C') {
        if (Panels.open === 'character') { Panels.close(); return; }
        if (!Panels.open && !BattleUI.active) { Panels.openCharacter(); return; }
    }
    // [Enter] focuses the chat input if chat is visible and not collapsed
    if (e.key === 'Enter') {
        if (typeof ChatUI !== 'undefined') {
            const chatInput = document.getElementById('chatInput');
            if (chatInput && !ChatUI.collapsed) {
                chatInput.focus();
                e.preventDefault();
                return;
            }
        }
    }

    if ((e.key === 'q' || e.key === 'Q') && !Panels.open && !BattleUI.active) {
        if (typeof QuestUI !== 'undefined') QuestUI.toggle();
        return;
    }
    if ((e.key === 'p' || e.key === 'P') && !Panels.open && !BattleUI.active) {
        if (typeof QuestUI !== 'undefined' && QuestUI.open) return;
        if (typeof PartyUI !== 'undefined') PartyUI.toggle();
        return;
    }
    if ((e.key === 'g' || e.key === 'G') && !Panels.open && !BattleUI.active) {
        if (typeof GuildUI !== 'undefined') GuildUI.toggle();
        return;
    }
    if ((e.key === 'm' || e.key === 'M') && !Panels.open && !BattleUI.active) {
        if (typeof WorldMapUI !== 'undefined') WorldMapUI.toggle();
        return;
    }
    if (e.key === 'Escape' && Panels.open)  { Panels.close(); return; }
    if (e.key === 'Escape' && typeof QuestUI     !== 'undefined' && QuestUI.open)     { QuestUI.close();     return; }
    if (e.key === 'Escape' && typeof PartyUI     !== 'undefined' && PartyUI.open)     { PartyUI.close();     return; }
    if (e.key === 'Escape' && typeof GuildUI     !== 'undefined' && GuildUI.open)     { GuildUI.close();     return; }
    if (e.key === 'Escape' && typeof WorldMapUI  !== 'undefined' && WorldMapUI.open)  { WorldMapUI.close();  return; }

    // Close dialogue/panels
    if (Game.dialogueOpen) {
        if (Panels.open) return; // Don't close panels with space/enter
        if (e.key === ' ' || e.key === 'Escape' || e.key === 'Enter') closeDialogue();
        return;
    }
    if (!Game.myHero) return;

    if (e.key === 'e' || e.key === 'E') { tryInteract(); return; }

    let tx = Game.myHero.x, ty = Game.myHero.y;
    if (e.key === 'w' || e.key === 'ArrowUp') ty--;
    else if (e.key === 's' || e.key === 'ArrowDown') ty++;
    else if (e.key === 'a' || e.key === 'ArrowLeft') tx--;
    else if (e.key === 'd' || e.key === 'ArrowRight') tx++;
    else return;

    if (tx < 0 || tx >= Game.map.width || ty < 0 || ty >= Game.map.height) return;
    const idx = ty * Game.map.width + tx;
    if (BLOCKED_TILES.includes(Game.map.tiles[idx])) return;

    Game.myHero.x = tx; Game.myHero.y = ty;
    updateCoordsUI();
    Game.socket.emit('move', { x: tx, y: ty });
    // Server handles STEP_ON events (teleports, traps, etc) via event_runner
});

function tryInteract() {
    const dirs = [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
    for (const d of dirs) {
        const x = Game.myHero.x + d.dx, y = Game.myHero.y + d.dy;
        const ev = Game.map.events.find(e => e.x === x && e.y === y);
        if (!ev) continue;

        // Send INTERACT to server — event_runner handles the logic
        Game.socket.emit('interact', { x, y });
        return;
    }
}

// --- RENDER ---
function draw() {
    CTX.fillStyle = '#050505';
    CTX.fillRect(0, 0, CANVAS.width, CANVAS.height);

    // Tiles
    for (let i = 0; i < Game.map.tiles.length; i++) {
        const x = (i % Game.map.width) * TILE_SIZE;
        const y = Math.floor(i / Game.map.width) * TILE_SIZE;
        CTX.fillStyle = COLORS[Game.map.tiles[i]] || '#ff00ff';
        CTX.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        CTX.strokeStyle = 'rgba(0,0,0,0.15)';
        CTX.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
    }

    // Events
    if (Array.isArray(Game.map.events)) {
        CTX.font = '16px sans-serif';
        CTX.textAlign = 'center';
        CTX.textBaseline = 'middle';
        for (const ev of Game.map.events) {
            const icon = EVENT_ICONS[ev.type];
            if (icon) CTX.fillText(icon, ev.x * TILE_SIZE + 16, ev.y * TILE_SIZE + 16);
        }
    }

    // Players
    Object.values(Game.players).forEach(p => {
        const px = p.x * TILE_SIZE, py = p.y * TILE_SIZE;
        const isMe = p.charId === Game.myCharId;
        // Shadow
        CTX.fillStyle = 'rgba(0,0,0,0.3)';
        CTX.fillRect(px + 4, py + 4, TILE_SIZE, TILE_SIZE);
        // Body
        CTX.fillStyle = isMe ? '#ffffff' : '#00ffff';
        CTX.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        // Border
        CTX.strokeStyle = isMe ? '#ffcc00' : '#008888';
        CTX.lineWidth = isMe ? 2 : 1;
        CTX.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
        CTX.lineWidth = 1;
        // Name
        CTX.fillStyle = '#fff';
        CTX.font = '10px Courier New';
        CTX.textAlign = 'center';
        CTX.textBaseline = 'alphabetic';
        CTX.fillText(p.name, px + 16, py - 4);
    });
}

function gameLoop() {
    draw();
    // Draw minimap on top every frame
    if (typeof MinimapUI !== 'undefined') MinimapUI.draw();
    requestAnimationFrame(gameLoop);
}
function updateCoordsUI() {
    document.getElementById('coordX').innerText = Game.myHero.x;
    document.getElementById('coordY').innerText = Game.myHero.y;
}
function updatePlayerCount() { document.getElementById('playerCount').innerText = Object.keys(Game.players).length; }

init();
