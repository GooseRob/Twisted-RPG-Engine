// =================================================================
// TWISTED ENGINE - SERVER v5.0 (The Authority)
// =================================================================
// TEACHING: This is the "brain". It connects to MySQL, serves files,
// handles login/save requests (HTTP), and real-time movement (WebSocket).
// RUN: npm install && node server.js → http://localhost:3000
// =================================================================

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/game');
const adminRoutes = require('./routes/admin');
const questRoutes = require('./routes/questRoutes');
const progressionRoutes = require('./routes/progressionRoutes');
const artifactRoutes = require('./routes/artifactRoutes');
const partyRoutes = require('./routes/partyRoutes');
const guildRoutes = require('./routes/guildRoutes');
const { getNpcReply } = require('./npc_brain');
const { handleMapEvent, executeActions } = require('./event_runner');
const BattleManager = require('./battle_engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/adminsauce', express.static(path.join(__dirname, 'public', 'adminsauce')));

// CONFIG — In production, use .env with dotenv!
const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'twisted_rpg',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const BLOCKED_TILES = [1, 2]; // 1=Wall, 2=Water

// --- GLOBAL STATE (lives in RAM, resets on restart) ---
let db;
let onlinePlayers = {};
let mapCache = {};
let npcMemory = {};

function safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
}

async function startServer() {
    try {
        db = mysql.createPool(DB_CONFIG);
        await db.query("SELECT 1");
        console.log("✅ DATABASE CONNECTED (Pool Mode)");

        authRoutes.init(db);
        gameRoutes.init(db);
        adminRoutes.init(db);
        questRoutes.init(db);
        progressionRoutes.init(db);
        artifactRoutes.init(db, io);
        partyRoutes.init(db);
        guildRoutes.init(db);
        app.use('/', authRoutes);
        app.use('/', gameRoutes);
        app.use('/', adminRoutes);
        app.use('/api/quests', questRoutes);
        app.use('/api/progression', progressionRoutes);
        app.use('/api/artifacts', artifactRoutes);
        app.use('/api/party', partyRoutes);
        app.use('/api/guild', guildRoutes);
        console.log("✅ ROUTES ACTIVE");

        // --- MAP CACHE HELPER ---
        async function getMapData(mapId) {
            if (mapCache[mapId]) return mapCache[mapId];
            const [rows] = await db.query("SELECT width, height, tiles_json, collisions_json FROM game_maps WHERE id = ?", [mapId]);
            if (rows.length === 0) return null;
            const m = rows[0];
            const mapObj = { width: m.width, height: m.height, tiles: safeJsonParse(m.tiles_json, []), events: safeJsonParse(m.collisions_json, []) };
            mapCache[mapId] = mapObj;
            return mapObj;
        }

        // --- STAFF GUARD (used for sensitive admin-only endpoints) ---
        // NOTE: This engine still uses a simple "userId in localStorage" login.
        // This guard prevents random users from calling staff-only endpoints,
        // but it is NOT a full security model until we add real sessions/JWT.
        async function isStaff(userId) {
            const uid = parseInt(userId, 10);
            if (!uid) return false;
            const [rows] = await db.query('SELECT role FROM users WHERE id=?', [uid]);
            if (!rows.length) return false;
            return ['ADMIN', 'GM', 'MOD'].includes(rows[0].role);
        }

        // Admin cache clear endpoint (STAFF ONLY)
        app.post('/admin/clear-cache', async (req, res) => {
            try {
                const userId = req.body.userId || req.headers['x-user-id'];
                if (!await isStaff(userId)) {
                    return res.status(403).json({ success: false, message: 'Forbidden' });
                }
                const { mapId } = req.body;
                if (mapId) delete mapCache[mapId]; else mapCache = {};
                res.json({ success: true });
            } catch (e) {
                console.error('clear-cache error:', e);
                res.status(500).json({ success: false, message: 'Server error' });
            }
        });

        // =============================================================
        // WEBSOCKET CONNECTIONS
        // =============================================================
        // --- PARTY IN-MEMORY STATE ---
        // Teaching: parties are stored in DB for persistence, but we also keep
        // an in-memory map for fast real-time lookups during a session.
        // Structure: { partyId: { id, leaderId, members: [charId,...] } }
        const activeParties = {};  // partyId -> party object
        const charPartyMap  = {};  // charId  -> partyId (quick lookup)

        // --- GUILD IN-MEMORY STATE ---
        // Guild memberships persist in DB. We keep a fast in-memory lookup
        // so we can route guild chat instantly without a DB query per message.
        // charGuildMap is populated when a player joins (join_game) and cleared on disconnect.
        const charGuildMap = {};   // charId -> { guildId, guildName, rank }

        // --- TRADE IN-MEMORY STATE ---
        // Trades are completely ephemeral — no DB write until completion.
        // Teaching: This is an example of "optimistic state" — we keep the
        // trade in RAM and only hit the DB when both parties confirm.
        const activeTrades = {};   // tradeId -> trade object
        let   tradeCounter = 1;    // simple ID generator

        // Helper: broadcast party state to all online members
        function broadcastPartyUpdate(partyId) {
            const party = activeParties[partyId];
            if (!party) return;
            party.members.forEach(cid => {
                const entry = Object.values(onlinePlayers).find(p => p.charId === cid);
                if (entry) {
                    io.to(entry.socketId).emit('party_update', party);
                }
            });
        }

        // Helper: get party member data for broadcast
        function buildPartyPayload(partyId) {
            const party = activeParties[partyId];
            if (!party) return null;
            return {
                id: partyId,
                leaderId: party.leaderId,
                members: party.members.map(cid => {
                    const p = Object.values(onlinePlayers).find(pl => pl.charId === cid);
                    return p ? { charId: p.charId, name: p.name, level: p.level, online: true }
                             : { charId: cid, online: false };
                })
            };
        }

        io.on('connection', (socket) => {
            console.log('⚡ SOCKET:', socket.id);
            let lastMoveTime = 0;

            // 1. JOIN GAME
            socket.on('join_game', async (data) => {
                try {
                    // PATCH #1: Prevent socket impersonation.
                    // Client MUST send { charId, userId } and the server verifies ownership.
                    if (!data || typeof data !== 'object') {
                        socket.emit('error_msg', 'join_game payload must be an object: { charId, userId }.');
                        return;
                    }
                    const charId = parseInt(data.charId, 10);
                    const userId = parseInt(data.userId, 10);
                    if (!charId || !userId) {
                        socket.emit('error_msg', 'Missing charId or userId. Please log in again.');
                        return;
                    }

                    const query = "SELECT * FROM characters WHERE id = ? AND user_id = ?";
                    const params = [charId, userId];

                    const [rows] = await db.query(query, params);
                    if (rows.length === 0) { socket.emit('error_msg', "Character not found."); return; }
                    const char = rows[0];
                    await getMapData(char.map_id);

                    // Fetch user role for chat permissions + admin room
                    const [userRows] = await db.query('SELECT role FROM users WHERE id=?', [char.user_id]);
                    const userRole = userRows.length ? (userRows[0].role || 'PLAYER') : 'PLAYER';
                    const isStaffRole = ['ADMIN', 'GM', 'MOD', 'STAFF', 'OWNER'].includes(userRole.toUpperCase());

                    onlinePlayers[socket.id] = {
                        socketId: socket.id, charId: char.id, userId: char.user_id,
                        name: char.name, mapId: char.map_id, x: char.x, y: char.y,
                        level: char.level, role: userRole
                    };
                    socket.join('map_' + char.map_id);
                    // Staff auto-join admin chat room
                    if (isStaffRole) socket.join('admin_chat');
                    socket.emit('init_self', {
                        ...onlinePlayers[socket.id],
                        hp: char.current_hp, maxHp: char.max_hp,
                        mp: char.current_mp || 0, maxMp: char.max_mp || 0,
                        atk: char.atk, def: char.def,
                        mo: char.mo, md: char.md,
                        speed: char.speed, luck: char.luck,
                        limitbreak: Number(char.limitbreak || 0),
                        breaklevel: Number(char.breaklevel || 1),
                        role: userRole
                    });
                    const mapPlayers = Object.values(onlinePlayers).filter(p => p.mapId === char.map_id);
                    socket.emit('player_list', mapPlayers);
                    socket.to('map_' + char.map_id).emit('player_joined', onlinePlayers[socket.id]);
                    console.log(`✅ ${char.name} joined Map ${char.map_id}`);
                } catch (err) { console.error("Join error:", err); socket.emit('error_msg', "Server error."); }
            });

            // 2. MOVEMENT (Server-Authoritative)
            socket.on('move', async (target) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const now = Date.now();
                    if (now - lastMoveTime < 80) return;
                    lastMoveTime = now;

                    const map = await getMapData(p.mapId);
                    if (!map) return;
                    const dist = Math.abs(target.x - p.x) + Math.abs(target.y - p.y);
                    if (dist !== 1) { socket.emit('force_move', { x: p.x, y: p.y }); return; }
                    if (target.x < 0 || target.x >= map.width || target.y < 0 || target.y >= map.height) { socket.emit('force_move', { x: p.x, y: p.y }); return; }
                    const tileId = map.tiles[target.y * map.width + target.x];
                    if (BLOCKED_TILES.includes(tileId)) { socket.emit('force_move', { x: p.x, y: p.y }); return; }

                    p.x = target.x; p.y = target.y;
                    socket.to('map_' + p.mapId).emit('player_moved', { id: p.charId, x: p.x, y: p.y });

                    // --- EVENT RUNNER: Check STEP_ON events at new position ---
                    if (Array.isArray(map.events)) {
                        // Load player state for condition checks
                        const [stateRows] = await db.query("SELECT state_json, level, class_id FROM characters WHERE id=?", [p.charId]);
                        const charState = stateRows.length ? safeJsonParse(stateRows[0].state_json, {}) : {};

                        const result = await handleMapEvent({
                            triggerType: 'STEP_ON',
                            x: p.x, y: p.y,
                            mapEvents: map.events,
                            socket, db,
                            player: { ...p, level: stateRows[0]?.level || 1, classId: stateRows[0]?.class_id || 1 },
                            state: charState
                        });

                        // Save modified state if actions changed it
                        if (result && result.state) {
                            await db.query("UPDATE characters SET state_json=? WHERE id=?",
                                [JSON.stringify(result.state), p.charId]);
                        }
                    }

                    // --- RANDOM ENCOUNTER CHECK ---
                    // Look up spawn zones for this map at this position
                    try {
                        const [spawns] = await db.query(
                            `SELECT * FROM game_map_spawns WHERE map_id=? AND enabled=1
                             AND ?>=x_min AND ?<=x_max AND ?>=y_min AND ?<=y_max`,
                            [p.mapId, p.x, p.x, p.y, p.y]
                        );
                        for (const zone of spawns) {
                            // Roll encounter chance
                            if (Math.random() * 100 >= (zone.encounter_rate || 10)) continue;
                            // Level check
                            const charLevel = p.level || 1;
                            if (charLevel < (zone.min_level || 1) || charLevel > (zone.max_level || 50)) continue;
                            // Flag check
                            if (zone.required_flag) {
                                const [flagRow] = await db.query("SELECT state_json FROM characters WHERE id=?", [p.charId]);
                                const flags = flagRow.length ? safeJsonParse(flagRow[0].state_json, {}) : {};
                                if (!flags[zone.required_flag]) continue;
                            }
                            // Pick an enemy from encounter table
                            const table = safeJsonParse(zone.encounter_table, []);
                            if (!table.length) continue;
                            // Weighted random selection
                            const totalWeight = table.reduce((s, e) => s + (e.weight || 1), 0);
                            let roll = Math.random() * totalWeight;
                            let picked = table[0];
                            for (const entry of table) {
                                roll -= (entry.weight || 1);
                                if (roll <= 0) { picked = entry; break; }
                            }
                            // Start PvE battle with this NPC
                            socket.emit('random_encounter', {
                                zoneName: zone.name,
                                npcId: picked.npc_id,
                                npcName: picked.name || 'Enemy'
                            });
                            break; // Only one encounter per step
                        }
                    } catch (spawnErr) { /* Silent fail — encounters are non-critical */ }
                } catch (err) { console.error("Move error:", err); }
            });

            // 3. TELEPORT
            socket.on('teleport', async (data) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const oldMap = p.mapId, newMap = parseInt(data.mapId);

                    // Fetch map data so we can use its spawn point if no coords given
                    const mapData = await getMapData(newMap);

                    socket.leave('map_' + oldMap);
                    socket.to('map_' + oldMap).emit('player_left', p.charId);

                    // Use provided coords, or the map's defined spawn, or dead-centre
                    const spawnX = data.x ? parseInt(data.x) : ((mapData && mapData.spawn_x) || Math.floor((mapData?.width  || 20) / 2));
                    const spawnY = data.y ? parseInt(data.y) : ((mapData && mapData.spawn_y) || Math.floor((mapData?.height || 20) / 2));

                    p.mapId = newMap; p.x = spawnX; p.y = spawnY;
                    await db.query("UPDATE characters SET map_id=?, x=?, y=? WHERE id=?", [newMap, spawnX, spawnY, p.charId]);
                    socket.join('map_' + newMap);

                    // Teaching: emit map_changed FIRST so client clears old canvas,
                    // THEN player_list so it can draw other players on the new map.
                    socket.emit('map_changed', {
                        mapId:   newMap,
                        mapName: mapData ? mapData.name : '',
                        x:       spawnX,
                        y:       spawnY,
                    });
                    // Exclude self from player_list — client already knows its own position
                    socket.emit('player_list', Object.values(onlinePlayers).filter(pl => pl.mapId === newMap && pl.charId !== p.charId));
                    socket.to('map_' + newMap).emit('player_joined', p);
                } catch (err) { console.error("Teleport error:", err); }
            });

            // 4. INTERACT (Replaces old npc_talk — handles ALL interact events)
            socket.on('interact', async ({ x, y }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const map = await getMapData(p.mapId);
                    if (!map) return;

                    // Load player state
                    const [stateRows] = await db.query("SELECT state_json, level, class_id FROM characters WHERE id=?", [p.charId]);
                    const charState = stateRows.length ? safeJsonParse(stateRows[0].state_json, {}) : {};

                    const result = await handleMapEvent({
                        triggerType: 'INTERACT',
                        x, y,
                        mapEvents: map.events,
                        socket, db,
                        player: { ...p, level: stateRows[0]?.level || 1, classId: stateRows[0]?.class_id || 1 },
                        state: charState
                    });

                    // Save modified state
                    if (result && result.state) {
                        await db.query("UPDATE characters SET state_json=? WHERE id=?",
                            [JSON.stringify(result.state), p.charId]);
                    }
                } catch (err) {
                    console.error("Interact error:", err);
                }
            });

            // 4b. NPC TALK (Legacy + LLM fallback — when client sends typed message)
            socket.on('npc_talk', async ({ x, y, message }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const map = await getMapData(p.mapId);
                    if (!map) return;
                    const ev = (map.events || []).find(e => e.x === x && e.y === y && e.type === 'NPC');
                    if (!ev) return;

                    // Load NPC persona from database
                    const [npcRows] = await db.query("SELECT * FROM game_npcs WHERE name = ?", [ev.data]);
                    let npc = { name: ev.data || 'Stranger' };
                    if (npcRows.length) { npc.persona = npcRows[0].ai_persona; npc.stats = safeJsonParse(npcRows[0].stats_json, {}); }

                    const memKey = `${p.charId}_${npc.name}`;
                    if (!npcMemory[memKey]) npcMemory[memKey] = [];
                    const history = npcMemory[memKey];
                    const reply = await getNpcReply({ npc, player: { name: p.name }, message, history });
                    history.push({ role: 'user', text: message }, { role: 'npc', text: reply });
                    if (history.length > 20) history.splice(0, 2);
                    socket.emit('npc_reply', { npcName: npc.name, text: reply });
                } catch (err) {
                    console.error("NPC error:", err);
                    socket.emit('npc_reply', { npcName: 'System', text: '*stares blankly* (Error)' });
                }
            });

            // 4c. CHOICE RESPONSE (Player picked an option from event_queue)
            socket.on('event_choice', async ({ optionId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p || !socket._pendingChoices) return;

                    const chosen = socket._pendingChoices[optionId];
                    socket._pendingChoices = null;

                    if (chosen && chosen.actions) {
                        const [stateRows] = await db.query("SELECT state_json, level, class_id FROM characters WHERE id=?", [p.charId]);
                        const charState = stateRows.length ? safeJsonParse(stateRows[0].state_json, {}) : {};

                        const result = await executeActions({
                            actions: chosen.actions,
                            socket, db,
                            player: { ...p, level: stateRows[0]?.level || 1, classId: stateRows[0]?.class_id || 1 },
                            state: charState
                        });

                        if (result && result.state) {
                            await db.query("UPDATE characters SET state_json=? WHERE id=?",
                                [JSON.stringify(result.state), p.charId]);
                        }
                    }
                } catch (err) { console.error("Choice error:", err); }
            });

            // =============================================================
            // BATTLE SYSTEM SOCKET HANDLERS
            // =============================================================

            // 5a. PVP CHALLENGE
            socket.on('battle_challenge', async ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    // Find target's socket
                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === targetCharId);
                    if (!targetEntry) { socket.emit('battle_error', 'Player not found.'); return; }
                    const targetSocket = io.sockets.sockets.get(targetEntry[0]);
                    if (!targetSocket) { socket.emit('battle_error', 'Player offline.'); return; }
                    // Send challenge
                    targetSocket.emit('battle_challenged', { challengerName: p.name, challengerCharId: p.charId });
                } catch (err) { console.error("Challenge error:", err); }
            });

            // 5b. ACCEPT PVP
            socket.on('battle_accept', async ({ challengerCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const challengerEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === challengerCharId);
                    if (!challengerEntry) return;
                    const challengerSocket = io.sockets.sockets.get(challengerEntry[0]);

                    const battleId = await BattleManager.createBattle(db, io, challengerSocket, socket, challengerCharId, p.charId, 'PVP');
                    if (battleId) {
                        // Join battle room and tag sockets with their charId
                        socket.join('battle_' + battleId);
                        socket._battleCharId = p.charId;
                        if (challengerSocket) {
                            challengerSocket.join('battle_' + battleId);
                            challengerSocket._battleCharId = challengerCharId;
                        }
                    }
                } catch (err) { console.error("Battle accept error:", err); }
            });

            // 5c. PVE BATTLE (from event_runner or encounter)
            socket.on('start_pve_battle', async ({ enemyCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const battleId = await BattleManager.createBattle(db, io, socket, null, p.charId, enemyCharId, 'PVE');
                    if (battleId) {
                        socket.join('battle_' + battleId);
                        socket._battleCharId = p.charId;
                    }
                } catch (err) { console.error("PVE start error:", err); }
            });

            // 5d. BATTLE ACTION (Attack, Skill, Item, Defend, Run, Limit)
            socket.on('battle_action', async (data) => {
                try {
                    await BattleManager.processAction(db, io, socket, data);
                } catch (err) { console.error("Battle action error:", err); }
            });

            // 5e. GET CHARACTER FULL DATA (for equipment screen)
            socket.on('get_char_data', async (callback) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const stats = await BattleManager.getEffectiveStats(db, p.charId);
                    // Get inventory
                    const [inv] = await db.query(`SELECT ci.*, gi.name, gi.icon, gi.type, gi.slot, gi.description, gi.value,
                        gi.bonus_atk, gi.bonus_def, gi.bonus_mo, gi.bonus_md, gi.bonus_speed, gi.bonus_luck, gi.bonus_hp, gi.bonus_mp,
                        gi.level_req, gi.set_status, gi.block_status, gi.elements
                        FROM character_items ci JOIN game_items gi ON ci.item_id = gi.id WHERE ci.character_id=?`, [p.charId]);
                    // Get equipment
                    const [equip] = await db.query(`SELECT ce.slot_key, gi.* FROM character_equipment ce
                        JOIN game_items gi ON ce.item_id = gi.id WHERE ce.character_id=?`, [p.charId]);
                    // Get equip slots
                    const [slots] = await db.query("SELECT * FROM game_equip_slots ORDER BY display_order");
                    // Get gold
                    const [userRow] = await db.query("SELECT currency FROM users WHERE id=?", [p.userId]);
                    const gold = userRow.length ? userRow[0].currency : 0;

                    if (typeof callback === 'function') {
                        callback({ stats, inventory: inv, equipment: equip, slots, gold });
                    } else {
                        socket.emit('char_data', { stats, inventory: inv, equipment: equip, slots, gold });
                    }
                } catch (err) { console.error("Char data error:", err); }
            });

            // 5f. EQUIP/UNEQUIP (via socket for real-time feedback)
            socket.on('equip_item', async ({ itemId, slotKey }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    // Direct DB logic (same as routes/game.js equip-item)
                    const [inv] = await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?", [p.charId, itemId]);
                    if (!inv.length) { socket.emit('equip_result', { success: false, message: 'Not in inventory.' }); return; }
                    const [itemR] = await db.query("SELECT * FROM game_items WHERE id=?", [itemId]);
                    if (!itemR.length) { socket.emit('equip_result', { success: false, message: 'Item not found.' }); return; }
                    if (itemR[0].slot !== slotKey && itemR[0].slot !== 'ANY') { socket.emit('equip_result', { success: false, message: `Goes in ${itemR[0].slot}.` }); return; }
                    // Unequip current
                    const [cur] = await db.query("SELECT * FROM character_equipment WHERE character_id=? AND slot_key=?", [p.charId, slotKey]);
                    if (cur.length) {
                        const [ex] = await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?", [p.charId, cur[0].item_id]);
                        if (ex.length) await db.query("UPDATE character_items SET quantity=quantity+1 WHERE id=?", [ex[0].id]);
                        else await db.query("INSERT INTO character_items(character_id,item_id,quantity)VALUES(?,?,1)", [p.charId, cur[0].item_id]);
                        await db.query("DELETE FROM character_equipment WHERE character_id=? AND slot_key=?", [p.charId, slotKey]);
                    }
                    // Equip new
                    await db.query("INSERT INTO character_equipment(character_id,slot_key,item_id)VALUES(?,?,?)", [p.charId, slotKey, itemId]);
                    if (inv[0].quantity > 1) await db.query("UPDATE character_items SET quantity=quantity-1 WHERE id=?", [inv[0].id]);
                    else await db.query("DELETE FROM character_items WHERE id=?", [inv[0].id]);
                    socket.emit('equip_result', { success: true, message: 'Equipped!' });
                } catch (err) { socket.emit('equip_result', { success: false, message: 'Error' }); }
            });

            socket.on('unequip_item', async ({ slotKey }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const [eq] = await db.query("SELECT * FROM character_equipment WHERE character_id=? AND slot_key=?", [p.charId, slotKey]);
                    if (!eq.length) { socket.emit('equip_result', { success: false, message: 'Nothing there.' }); return; }
                    const [ex] = await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?", [p.charId, eq[0].item_id]);
                    if (ex.length) await db.query("UPDATE character_items SET quantity=quantity+1 WHERE id=?", [ex[0].id]);
                    else await db.query("INSERT INTO character_items(character_id,item_id,quantity)VALUES(?,?,1)", [p.charId, eq[0].item_id]);
                    await db.query("DELETE FROM character_equipment WHERE character_id=? AND slot_key=?", [p.charId, slotKey]);
                    socket.emit('equip_result', { success: true, message: 'Unequipped.' });
                } catch (err) { socket.emit('equip_result', { success: false, message: 'Error' }); }
            });

            // =============================================================
            // 7. CHAT SYSTEM — 7 Channels
            // =============================================================
            // Channels: global | local | party | guild | dm | announce | admin
            // Teaching: Each channel routes messages differently:
            //   - global:   Every connected socket gets it (io.emit)
            //   - local:    Only players on the same map (Socket.IO rooms we already use!)
            //   - party:    Party members only (stubbed — party system TBD)
            //   - guild:    Guild members only (stubbed — guild system TBD)
            //   - dm:       Two specific sockets — sender and one target
            //   - announce: Staff only to send; everyone receives
            //   - admin:    Staff only to send AND receive (admin_chat room)

            socket.on('chat_send', async ({ channel, text, targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;

                    // Sanitize: cap at 300 chars, strip HTML
                    const msg = String(text || '').trim().slice(0, 300).replace(/</g, '&lt;');
                    if (!msg) return;

                    const payload = {
                        channel,
                        from: p.name,
                        fromCharId: p.charId,
                        text: msg,
                        ts: Date.now()
                    };

                    const sysMsg = (txt) => socket.emit('chat_msg', {
                        channel: 'system', from: 'System', text: txt, ts: Date.now()
                    });

                    switch (channel) {

                        // --- GLOBAL: everyone sees it ---
                        case 'global':
                            io.emit('chat_msg', payload);
                            break;

                        // --- LOCAL/ZONE: only players on same map ---
                        case 'local':
                            io.to('map_' + p.mapId).emit('chat_msg', payload);
                            break;

                        // --- PARTY: use party room if player is in one ---
                        case 'party': {
                            const pPartyId = charPartyMap[p.charId];
                            if (!pPartyId) { sysMsg('You are not in a party.'); return; }
                            io.to('party_' + pPartyId).emit('chat_msg', payload);
                            break;
                        }

                        // --- GUILD: route to guild room if player is in one ---
                        case 'guild': {
                            const myGuild = charGuildMap[p.charId];
                            if (!myGuild) { sysMsg('You are not in a guild.'); return; }
                            io.to('guild_' + myGuild.guildId).emit('chat_msg', payload);
                            break;
                        }

                        // --- DM: direct message to one player ---
                        case 'dm': {
                            if (!targetCharId) { sysMsg('No target selected for DM.'); return; }
                            const targetEntry = Object.entries(onlinePlayers)
                                .find(([, pl]) => pl.charId === parseInt(targetCharId, 10));
                            if (!targetEntry) { sysMsg('Player not found or offline.'); return; }
                            const targetSock = io.sockets.sockets.get(targetEntry[0]);
                            const dmPayload = { ...payload, targetName: targetEntry[1].name };
                            socket.emit('chat_msg', dmPayload);        // sender sees it
                            if (targetSock) targetSock.emit('chat_msg', dmPayload); // receiver gets it
                            break;
                        }

                        // --- ANNOUNCE: staff sends, everyone receives ---
                        case 'announce':
                            if (!await isStaff(p.userId)) { sysMsg('Staff only.'); return; }
                            io.emit('chat_msg', { ...payload, channel: 'announce' });
                            break;

                        // --- ADMIN: staff only, hidden from regular players ---
                        case 'admin':
                            if (!await isStaff(p.userId)) { sysMsg('Staff only.'); return; }
                            // Only sockets in admin_chat room receive this
                            io.to('admin_chat').emit('chat_msg', payload);
                            break;

                        default:
                            sysMsg('Unknown channel: ' + channel);
                    }
                } catch (err) { console.error('Chat error:', err); }
            });

            // --- GUILD: look up this player's guild and join the room ---
            // Teaching: On login we immediately join the socket room for the
            // player's guild (if any) so guild chat starts working right away.
            (async () => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const [guildRow] = await db.query(
                        `SELECT gm.guild_id, gm.rank, g.name AS guild_name
                         FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
                         WHERE gm.character_id = ? AND gm.is_active = 1 AND g.is_active = 1 LIMIT 1`,
                        [p.charId]
                    );
                    if (guildRow.length) {
                        const gm = guildRow[0];
                        charGuildMap[p.charId] = { guildId: gm.guild_id, guildName: gm.guild_name, rank: gm.rank };
                        socket.join('guild_' + gm.guild_id);
                        // Send current guild membership info to client
                        socket.emit('guild_joined', { guildId: gm.guild_id, guildName: gm.guild_name, rank: gm.rank });
                    }
                } catch (e) { /* non-critical */ }
            })();

            // =============================================================
            // 9. GUILD SYSTEM — Real-time guild management
            // =============================================================

            // INVITE player to guild
            socket.on('guild_invite', async ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const myGuild = charGuildMap[p.charId];
                    if (!myGuild) { socket.emit('guild_msg', { text: 'You are not in a guild.', type: 'error' }); return; }
                    if (!['LEADER', 'OFFICER'].includes(myGuild.rank)) {
                        socket.emit('guild_msg', { text: 'Only officers and leaders can invite.', type: 'error' }); return;
                    }
                    // Check target is online
                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                    if (!targetEntry) { socket.emit('guild_msg', { text: 'Player is offline.', type: 'error' }); return; }
                    const [, targetPlayer] = targetEntry;
                    if (charGuildMap[targetPlayer.charId]) {
                        socket.emit('guild_msg', { text: 'Player is already in a guild.', type: 'error' }); return;
                    }

                    // Persist invite to DB
                    await db.query(
                        "INSERT INTO guild_invites (guild_id, inviter_id, invitee_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE status='pending', created_at=NOW()",
                        [myGuild.guildId, p.charId, targetCharId]
                    );

                    // Notify target
                    const targetSocket = io.sockets.sockets.get(targetEntry[0]);
                    if (targetSocket) {
                        targetSocket.emit('guild_invited', {
                            guildId: myGuild.guildId,
                            guildName: myGuild.guildName,
                            inviterName: p.name
                        });
                    }
                    socket.emit('guild_msg', { text: `Invite sent to ${targetPlayer.name}.`, type: 'info' });
                } catch (e) { console.error('guild_invite error:', e); }
            });

            // ACCEPT guild invite
            socket.on('guild_accept', async ({ guildId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    if (charGuildMap[p.charId]) {
                        socket.emit('guild_msg', { text: 'Leave your current guild first.', type: 'error' }); return;
                    }

                    // Validate invite
                    const [inv] = await db.query(
                        "SELECT * FROM guild_invites WHERE guild_id=? AND invitee_id=? AND status='pending' AND expires_at>NOW() LIMIT 1",
                        [guildId, p.charId]
                    );
                    if (!inv.length) { socket.emit('guild_msg', { text: 'Invite not found or expired.', type: 'error' }); return; }

                    // Check guild exists and has space
                    const [guild] = await db.query('SELECT * FROM guilds WHERE id=? AND is_active=1', [guildId]);
                    if (!guild.length) { socket.emit('guild_msg', { text: 'Guild no longer exists.', type: 'error' }); return; }
                    const [count] = await db.query('SELECT COUNT(*) AS c FROM guild_members WHERE guild_id=? AND is_active=1', [guildId]);
                    if (count[0].c >= guild[0].max_members) {
                        socket.emit('guild_msg', { text: 'Guild is full.', type: 'error' }); return;
                    }

                    // Join guild
                    await db.query(
                        "INSERT INTO guild_members (guild_id, character_id, rank) VALUES (?,?,'MEMBER') ON DUPLICATE KEY UPDATE is_active=1, left_at=NULL, rank='MEMBER'",
                        [guildId, p.charId]
                    );
                    await db.query("UPDATE guild_invites SET status='accepted' WHERE guild_id=? AND invitee_id=?", [guildId, p.charId]);

                    charGuildMap[p.charId] = { guildId, guildName: guild[0].name, rank: 'MEMBER' };
                    socket.join('guild_' + guildId);
                    socket.emit('guild_joined', { guildId, guildName: guild[0].name, rank: 'MEMBER' });

                    io.to('guild_' + guildId).emit('chat_msg', {
                        channel: 'guild', from: 'System',
                        text: `${p.name} joined the guild!`, ts: Date.now()
                    });
                } catch (e) { console.error('guild_accept error:', e); }
            });

            // DECLINE guild invite
            socket.on('guild_decline', async ({ guildId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    await db.query("UPDATE guild_invites SET status='declined' WHERE guild_id=? AND invitee_id=?", [guildId, p.charId]);
                } catch (e) { console.error('guild_decline error:', e); }
            });

            // LEAVE guild
            socket.on('guild_leave', async () => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    await _leaveGuild(socket, p);
                } catch (e) { console.error('guild_leave error:', e); }
            });

            // KICK member (leader/officer only)
            socket.on('guild_kick', async ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const myGuild = charGuildMap[p.charId];
                    if (!myGuild || !['LEADER','OFFICER'].includes(myGuild.rank)) return;

                    // Remove from DB
                    await db.query('UPDATE guild_members SET is_active=0, left_at=NOW() WHERE guild_id=? AND character_id=?', [myGuild.guildId, targetCharId]);

                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                    if (targetEntry) {
                        const [tSockId] = targetEntry;
                        const tSock = io.sockets.sockets.get(tSockId);
                        if (tSock) {
                            delete charGuildMap[parseInt(targetCharId)];
                            tSock.leave('guild_' + myGuild.guildId);
                            tSock.emit('guild_left', {});
                            tSock.emit('guild_msg', { text: 'You were kicked from the guild.', type: 'error' });
                        }
                    }
                    io.to('guild_' + myGuild.guildId).emit('chat_msg', {
                        channel: 'guild', from: 'System',
                        text: `A member was removed from the guild.`, ts: Date.now()
                    });
                } catch (e) { console.error('guild_kick error:', e); }
            });

            // PROMOTE / DEMOTE
            socket.on('guild_set_rank', async ({ targetCharId, rank }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const myGuild = charGuildMap[p.charId];
                    if (!myGuild || myGuild.rank !== 'LEADER') { socket.emit('guild_msg', { text: 'Only the leader can change ranks.', type: 'error' }); return; }
                    if (!['OFFICER','MEMBER'].includes(rank)) return;
                    await db.query('UPDATE guild_members SET rank=? WHERE guild_id=? AND character_id=? AND is_active=1', [rank, myGuild.guildId, targetCharId]);
                    // Update in-memory if online
                    if (charGuildMap[parseInt(targetCharId)]) charGuildMap[parseInt(targetCharId)].rank = rank;
                    socket.emit('guild_msg', { text: `Rank updated.`, type: 'info' });
                } catch (e) { console.error('guild_set_rank error:', e); }
            });

            // Internal helper — leave / disband guild
            async function _leaveGuild(leavingSocket, player) {
                const guildInfo = charGuildMap[player.charId];
                if (!guildInfo) return;
                const { guildId, guildName } = guildInfo;

                // If leader, transfer or disband
                const [guild] = await db.query('SELECT * FROM guilds WHERE id=? AND is_active=1', [guildId]);
                if (!guild.length) { delete charGuildMap[player.charId]; return; }

                await db.query('UPDATE guild_members SET is_active=0, left_at=NOW() WHERE guild_id=? AND character_id=?', [guildId, player.charId]);
                delete charGuildMap[player.charId];
                leavingSocket.leave('guild_' + guildId);
                leavingSocket.emit('guild_left', {});

                if (guild[0].leader_id === player.charId) {
                    // Try to find next officer or member to be leader
                    const [next] = await db.query(
                        "SELECT character_id FROM guild_members WHERE guild_id=? AND is_active=1 ORDER BY FIELD(rank,'OFFICER','MEMBER') LIMIT 1",
                        [guildId]
                    );
                    if (next.length) {
                        await db.query('UPDATE guilds SET leader_id=? WHERE id=?', [next[0].character_id, guildId]);
                        await db.query("UPDATE guild_members SET rank='LEADER' WHERE guild_id=? AND character_id=?", [guildId, next[0].character_id]);
                        if (charGuildMap[next[0].character_id]) charGuildMap[next[0].character_id].rank = 'LEADER';
                        io.to('guild_' + guildId).emit('chat_msg', {
                            channel: 'guild', from: 'System',
                            text: `${player.name} left. Leadership transferred.`, ts: Date.now()
                        });
                    } else {
                        // No members left — disband
                        await db.query('UPDATE guilds SET is_active=0, disbanded_at=NOW() WHERE id=?', [guildId]);
                        io.to('guild_' + guildId).emit('guild_left', {});
                    }
                } else {
                    io.to('guild_' + guildId).emit('chat_msg', {
                        channel: 'guild', from: 'System', text: `${player.name} left the guild.`, ts: Date.now()
                    });
                }
            }

            // =============================================================
            // 10. TRADE SYSTEM — Real-time player-to-player item trading
            // =============================================================
            // Teaching: A trade has two sides (initiator and recipient).
            // Each side can add items. Both sides must LOCK (finalise their
            // offer) before the trade can be CONFIRMED. If both confirm,
            // items swap atomically in the DB. Either side can cancel at any point.

            // REQUEST trade with another player
            socket.on('trade_request', ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                    if (!targetEntry) { socket.emit('trade_msg', { text: 'Player is offline.', type: 'error' }); return; }
                    const [tSockId, tPlayer] = targetEntry;

                    io.to(tSockId).emit('trade_requested', { fromName: p.name, fromCharId: p.charId });
                    socket.emit('trade_msg', { text: `Trade request sent to ${tPlayer.name}.`, type: 'info' });
                } catch (e) { console.error('trade_request error:', e); }
            });

            // ACCEPT trade — create the trade object
            socket.on('trade_accept', ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                    if (!targetEntry) { socket.emit('trade_msg', { text: 'Player went offline.', type: 'error' }); return; }
                    const [tSockId, tPlayer] = targetEntry;

                    const tradeId = 'T' + (tradeCounter++);
                    activeTrades[tradeId] = {
                        id: tradeId,
                        sides: {
                            [p.charId]:       { charId: p.charId,       name: p.name,       items: [], gold: 0, locked: false, confirmed: false },
                            [tPlayer.charId]: { charId: tPlayer.charId, name: tPlayer.name, items: [], gold: 0, locked: false, confirmed: false }
                        }
                    };

                    // Both players join trade room
                    socket.join('trade_' + tradeId);
                    const targetSocket = io.sockets.sockets.get(tSockId);
                    if (targetSocket) targetSocket.join('trade_' + tradeId);

                    io.to('trade_' + tradeId).emit('trade_start', { tradeId, trade: activeTrades[tradeId] });
                } catch (e) { console.error('trade_accept error:', e); }
            });

            // DECLINE trade request
            socket.on('trade_decline', ({ targetCharId }) => {
                const p = onlinePlayers[socket.id];
                if (!p) return;
                const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                if (targetEntry) {
                    io.to(targetEntry[0]).emit('trade_msg', { text: `${p.name} declined the trade.`, type: 'info' });
                }
            });

            // ADD ITEM to trade
            socket.on('trade_add_item', async ({ tradeId, itemId, quantity }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const trade = activeTrades[tradeId];
                    if (!trade || !trade.sides[p.charId]) return;

                    const mySide = trade.sides[p.charId];
                    if (mySide.locked) { socket.emit('trade_msg', { text: 'Unlock your side first.', type: 'error' }); return; }

                    // Verify item is in inventory
                    const [inv] = await db.query(
                        'SELECT ci.*, gi.name, gi.icon, gi.type FROM character_items ci JOIN game_items gi ON ci.item_id=gi.id WHERE ci.character_id=? AND ci.item_id=?',
                        [p.charId, itemId]
                    );
                    if (!inv.length) { socket.emit('trade_msg', { text: 'Item not found.', type: 'error' }); return; }
                    const item = inv[0];
                    const qty = Math.min(parseInt(quantity) || 1, item.quantity);

                    // Add or increment in trade
                    const existing = mySide.items.find(i => i.itemId === itemId);
                    if (existing) existing.quantity = Math.min(existing.quantity + qty, item.quantity);
                    else mySide.items.push({ itemId, name: item.name, icon: item.icon, quantity: qty });

                    // Reset confirms when offer changes
                    mySide.confirmed = false;

                    io.to('trade_' + tradeId).emit('trade_update', { tradeId, trade });
                } catch (e) { console.error('trade_add_item error:', e); }
            });

            // REMOVE ITEM from trade
            socket.on('trade_remove_item', ({ tradeId, itemId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const trade = activeTrades[tradeId];
                    if (!trade || !trade.sides[p.charId]) return;
                    const mySide = trade.sides[p.charId];
                    if (mySide.locked) return;
                    mySide.items = mySide.items.filter(i => i.itemId !== itemId);
                    mySide.confirmed = false;
                    io.to('trade_' + tradeId).emit('trade_update', { tradeId, trade });
                } catch (e) { console.error('trade_remove_item error:', e); }
            });

            // SET GOLD offer
            socket.on('trade_set_gold', ({ tradeId, amount }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const trade = activeTrades[tradeId];
                    if (!trade || !trade.sides[p.charId]) return;
                    const mySide = trade.sides[p.charId];
                    if (mySide.locked) return;
                    mySide.gold = Math.max(0, parseInt(amount) || 0);
                    mySide.confirmed = false;
                    io.to('trade_' + tradeId).emit('trade_update', { tradeId, trade });
                } catch (e) { console.error('trade_set_gold error:', e); }
            });

            // LOCK trade side
            socket.on('trade_lock', ({ tradeId }) => {
                const p = onlinePlayers[socket.id];
                if (!p) return;
                const trade = activeTrades[tradeId];
                if (!trade || !trade.sides[p.charId]) return;
                trade.sides[p.charId].locked = !trade.sides[p.charId].locked;
                trade.sides[p.charId].confirmed = false;
                io.to('trade_' + tradeId).emit('trade_update', { tradeId, trade });
            });

            // CONFIRM trade — if both confirm and both locked, execute
            socket.on('trade_confirm', async ({ tradeId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const trade = activeTrades[tradeId];
                    if (!trade || !trade.sides[p.charId]) return;

                    const mySide = trade.sides[p.charId];
                    if (!mySide.locked) { socket.emit('trade_msg', { text: 'Lock your offer first.', type: 'error' }); return; }
                    mySide.confirmed = true;

                    io.to('trade_' + tradeId).emit('trade_update', { tradeId, trade });

                    // Check if BOTH sides confirmed
                    const sides = Object.values(trade.sides);
                    if (!sides.every(s => s.locked && s.confirmed)) return;

                    // EXECUTE TRADE
                    const [sideA, sideB] = sides;

                    // Verify gold balances
                    const [userA] = await db.query('SELECT currency FROM users WHERE id=(SELECT user_id FROM characters WHERE id=?)', [sideA.charId]);
                    const [userB] = await db.query('SELECT currency FROM users WHERE id=(SELECT user_id FROM characters WHERE id=?)', [sideB.charId]);
                    if ((userA[0]?.currency || 0) < sideA.gold || (userB[0]?.currency || 0) < sideB.gold) {
                        io.to('trade_' + tradeId).emit('trade_cancelled', { reason: 'Insufficient gold.' });
                        delete activeTrades[tradeId];
                        return;
                    }

                    // Verify items still in inventory (race condition guard)
                    for (const side of sides) {
                        for (const it of side.items) {
                            const [inv] = await db.query('SELECT quantity FROM character_items WHERE character_id=? AND item_id=?', [side.charId, it.itemId]);
                            if (!inv.length || inv[0].quantity < it.quantity) {
                                io.to('trade_' + tradeId).emit('trade_cancelled', { reason: `${side.name} no longer has the offered item(s).` });
                                delete activeTrades[tradeId];
                                return;
                            }
                        }
                    }

                    // Swap items
                    for (const [giver, receiver] of [[sideA, sideB], [sideB, sideA]]) {
                        for (const it of giver.items) {
                            // Remove from giver
                            const [inv] = await db.query('SELECT id, quantity FROM character_items WHERE character_id=? AND item_id=?', [giver.charId, it.itemId]);
                            if (inv[0].quantity > it.quantity) await db.query('UPDATE character_items SET quantity=quantity-? WHERE id=?', [it.quantity, inv[0].id]);
                            else await db.query('DELETE FROM character_items WHERE id=?', [inv[0].id]);
                            // Give to receiver
                            const [ex] = await db.query('SELECT id FROM character_items WHERE character_id=? AND item_id=?', [receiver.charId, it.itemId]);
                            if (ex.length) await db.query('UPDATE character_items SET quantity=quantity+? WHERE id=?', [it.quantity, ex[0].id]);
                            else await db.query('INSERT INTO character_items (character_id,item_id,quantity) VALUES (?,?,?)', [receiver.charId, it.itemId, it.quantity]);
                        }
                    }

                    // Swap gold via user_id lookup
                    if (sideA.gold > 0) {
                        await db.query('UPDATE users SET currency=currency-? WHERE id=(SELECT user_id FROM characters WHERE id=?)', [sideA.gold, sideA.charId]);
                        await db.query('UPDATE users SET currency=currency+? WHERE id=(SELECT user_id FROM characters WHERE id=?)', [sideA.gold, sideB.charId]);
                    }
                    if (sideB.gold > 0) {
                        await db.query('UPDATE users SET currency=currency-? WHERE id=(SELECT user_id FROM characters WHERE id=?)', [sideB.gold, sideB.charId]);
                        await db.query('UPDATE users SET currency=currency+? WHERE id=(SELECT user_id FROM characters WHERE id=?)', [sideB.gold, sideA.charId]);
                    }

                    // Audit log
                    await db.query(
                        'INSERT INTO character_trade_log (initiator_id, recipient_id, initiator_items, recipient_items, initiator_gold, recipient_gold) VALUES (?,?,?,?,?,?)',
                        [sideA.charId, sideB.charId, JSON.stringify(sideA.items), JSON.stringify(sideB.items), sideA.gold, sideB.gold]
                    ).catch(() => {}); // Non-critical — don't fail trade if log fails

                    io.to('trade_' + tradeId).emit('trade_complete', { tradeId });
                    delete activeTrades[tradeId];
                } catch (e) { console.error('trade_confirm error:', e); }
            });

            // CANCEL trade
            socket.on('trade_cancel', ({ tradeId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const trade = activeTrades[tradeId];
                    if (!trade || !trade.sides[p.charId]) return;
                    io.to('trade_' + tradeId).emit('trade_cancelled', { reason: `${p.name} cancelled the trade.` });
                    delete activeTrades[tradeId];
                } catch (e) { console.error('trade_cancel error:', e); }
            });

            // 8. PARTY SYSTEM — Real-time party management
            // =============================================================
            // Teaching: friends are persisted in DB via REST (/api/party/).
            // Party membership is handled here via sockets for real-time
            // invites/joins/leaves, and also saved to DB for persistence.

            // INVITE to party
            socket.on('party_invite', async ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;

                    // Find target socket
                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                    if (!targetEntry) { socket.emit('party_msg', { text: 'Player is offline.', type: 'error' }); return; }
                    const [targetSockId, targetPlayer] = targetEntry;

                    // Can't invite self or someone already in a party with you
                    if (targetPlayer.charId === p.charId) return;
                    if (charPartyMap[targetPlayer.charId] && charPartyMap[targetPlayer.charId] === charPartyMap[p.charId]) {
                        socket.emit('party_msg', { text: 'Already in your party.', type: 'error' }); return;
                    }

                    // Create or find party for inviter
                    let partyId = charPartyMap[p.charId];
                    if (!partyId) {
                        // Create new party in DB
                        const [result] = await db.query(
                            'INSERT INTO character_parties (leader_id, is_active) VALUES (?,1)', [p.charId]
                        );
                        partyId = result.insertId;
                        await db.query(
                            "INSERT INTO character_party_members (party_id, character_id, role) VALUES (?,?,'leader')",
                            [partyId, p.charId]
                        );
                        activeParties[partyId] = { id: partyId, leaderId: p.charId, members: [p.charId] };
                        charPartyMap[p.charId] = partyId;
                        socket.join('party_' + partyId);
                    }

                    const party = activeParties[partyId];
                    if (party.members.length >= 4) {
                        socket.emit('party_msg', { text: 'Party is full (max 4).', type: 'error' }); return;
                    }

                    // Send invite to target
                    io.to(targetSockId).emit('party_invited', {
                        partyId, inviterName: p.name, inviterCharId: p.charId
                    });
                    socket.emit('party_msg', { text: `Invite sent to ${targetPlayer.name}.`, type: 'info' });
                } catch (err) { console.error('party_invite error:', err); }
            });

            // ACCEPT party invite
            socket.on('party_accept', async ({ partyId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;

                    const party = activeParties[partyId];
                    if (!party) { socket.emit('party_msg', { text: 'Party no longer exists.', type: 'error' }); return; }
                    if (party.members.length >= 4) { socket.emit('party_msg', { text: 'Party is full.', type: 'error' }); return; }

                    // Leave old party if any
                    const oldPartyId = charPartyMap[p.charId];
                    if (oldPartyId && oldPartyId !== partyId) {
                        await _leaveParty(socket, p, oldPartyId);
                    }

                    // Join
                    party.members.push(p.charId);
                    charPartyMap[p.charId] = partyId;
                    socket.join('party_' + partyId);

                    await db.query(
                        "INSERT INTO character_party_members (party_id, character_id, role) VALUES (?,?,'member') ON DUPLICATE KEY UPDATE is_active=1, left_at=NULL",
                        [partyId, p.charId]
                    );

                    io.to('party_' + partyId).emit('party_update', buildPartyPayload(partyId));
                    io.to('party_' + partyId).emit('chat_msg', {
                        channel: 'party', from: 'System', text: `${p.name} joined the party!`, ts: Date.now()
                    });
                } catch (err) { console.error('party_accept error:', err); }
            });

            // DECLINE party invite
            socket.on('party_decline', ({ partyId }) => {
                const p = onlinePlayers[socket.id];
                if (!p) return;
                const party = activeParties[partyId];
                if (!party) return;
                const leaderEntry = Object.values(onlinePlayers).find(pl => pl.charId === party.leaderId);
                if (leaderEntry) {
                    io.to(leaderEntry.socketId).emit('party_msg', { text: `${p.name} declined your party invite.`, type: 'info' });
                }
            });

            // LEAVE party
            socket.on('party_leave', async () => {
                const p = onlinePlayers[socket.id];
                if (!p) return;
                const partyId = charPartyMap[p.charId];
                if (!partyId) return;
                await _leaveParty(socket, p, partyId);
            });

            // KICK member (leader only)
            socket.on('party_kick', async ({ targetCharId }) => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (!p) return;
                    const partyId = charPartyMap[p.charId];
                    if (!partyId) return;
                    const party = activeParties[partyId];
                    if (!party || party.leaderId !== p.charId) {
                        socket.emit('party_msg', { text: 'Only the leader can kick.', type: 'error' }); return;
                    }
                    const targetEntry = Object.entries(onlinePlayers).find(([, pl]) => pl.charId === parseInt(targetCharId));
                    if (targetEntry) {
                        const [tSockId, tPlayer] = targetEntry;
                        await _leaveParty(io.sockets.sockets.get(tSockId), tPlayer, partyId, true);
                        io.to(tSockId).emit('party_msg', { text: 'You were kicked from the party.', type: 'error' });
                    }
                } catch (err) { console.error('party_kick error:', err); }
            });

            // PARTY CHAT — wire the stubbed channel now that party system exists
            // (overwrites the stub in the chat handler above — we route party messages here)

            // Internal helper — leave or disband party
            async function _leaveParty(leavingSocket, player, partyId, isKick = false) {
                const party = activeParties[partyId];
                if (!party) return;

                party.members = party.members.filter(id => id !== player.charId);
                delete charPartyMap[player.charId];
                if (leavingSocket) {
                    leavingSocket.leave('party_' + partyId);
                    leavingSocket.emit('party_update', null); // clears party UI
                }

                await db.query(
                    "UPDATE character_party_members SET is_active=0, left_at=NOW() WHERE party_id=? AND character_id=?",
                    [partyId, player.charId]
                );

                if (party.members.length === 0) {
                    // Disband
                    delete activeParties[partyId];
                    await db.query("UPDATE character_parties SET is_active=0, disbanded_at=NOW() WHERE id=?", [partyId]);
                } else if (party.leaderId === player.charId) {
                    // Transfer leadership to next member
                    party.leaderId = party.members[0];
                    await db.query("UPDATE character_parties SET leader_id=? WHERE id=?", [party.leaderId, partyId]);
                    io.to('party_' + partyId).emit('party_update', buildPartyPayload(partyId));
                    io.to('party_' + partyId).emit('chat_msg', {
                        channel: 'party', from: 'System',
                        text: `${player.name} left. Leadership passed.`, ts: Date.now()
                    });
                } else {
                    io.to('party_' + partyId).emit('party_update', buildPartyPayload(partyId));
                    const verb = isKick ? 'was kicked' : 'left the party';
                    io.to('party_' + partyId).emit('chat_msg', {
                        channel: 'party', from: 'System',
                        text: `${player.name} ${verb}.`, ts: Date.now()
                    });
                }
            }

            // 6. DISCONNECT
            socket.on('disconnect', async () => {
                try {
                    const p = onlinePlayers[socket.id];
                    if (p) {
                        await db.query("UPDATE characters SET x=?, y=?, map_id=? WHERE id=?", [p.x, p.y, p.mapId, p.charId]);
                        socket.to('map_' + p.mapId).emit('player_left', p.charId);
                        // Clean up party membership on disconnect
                        const partyId = charPartyMap[p.charId];
                        if (partyId) {
                            await _leaveParty(socket, p, partyId);
                        }
                        delete onlinePlayers[socket.id];
                    }
                } catch (err) { console.error("Disconnect error:", err); }
            });
        });

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => { console.log(`🚀 SERVER: http://localhost:${PORT}`); });
    } catch (err) { console.error("❌ STARTUP:", err); process.exit(1); }
}

startServer();
