// =================================================================
// BATTLE ENGINE v1.0 — Turn-Based Combat (The Arena)
// =================================================================
// ARCHITECTURE:
//   This is a SERVER-AUTHORITATIVE battle system.
//   The client sends commands ("I use Attack", "I cast Fire").
//   The server validates everything and sends back results.
//   The client just plays animations.
//
// FLOW:
//   1. Server creates a battle (via event_runner BATTLE action or PvP challenge)
//   2. Both combatants get a "battle_start" event with full state
//   3. Each turn: active player picks a command → server resolves → broadcast
//   4. Battle ends on death, flee, timeout
//
// WHAT'S DATA-DRIVEN (from MySQL):
//   - Battle commands (Attack, Defend, Skills, Items, Run)
//   - Skills (damage formulas, elements, status effects)
//   - Status effects (poison tick, stun, stat mods, turn duration)
//   - Elements (weakness/resistance system)
//   - Items (consumable effects in combat)
//   - Limit breaks (per-class ultimate abilities)
//   - Level table (XP/gold rewards)
// =================================================================

const { safeEval } = require('./event_runner');

// Optional Legendary Artifacts hook.
// If your project includes routes/artifactRoutes.js (with init(db) + onPvpKill()),
// the battle engine will call it when a PvP battle ends with a kill.
let artifactRoutes = null;
try {
    artifactRoutes = require('./routes/artifactRoutes');
} catch (e) {
    // Not installed in this build — totally fine.
    artifactRoutes = null;
}

function jp(s, f) { try { return JSON.parse(s); } catch { return f; } }

// =================================================================
// STAT CALCULATOR — Equipment + Status Modifiers
// =================================================================
// This is called BEFORE every action to get the "effective" stats.
// Base stats come from the character table.
// Equipment bonuses come from character_equipment + game_items.
// Status mods (ATK Up, etc.) come from active status_effects.
// Returns the final stat block used in all formulas.

async function getEffectiveStats(db, charId) {
    // 1. Base stats
    const [charRows] = await db.query("SELECT * FROM characters WHERE id=?", [charId]);
    if (!charRows.length) return null;
    const c = charRows[0];

    const stats = {
        charId: c.id,
        userId: c.user_id,
        name: c.name,
        level: c.level,
        classId: c.class_id,
        raceId: c.race_id,
        // HP/MP (current, not max — max is calculated)
        currentHp: c.current_hp,
        maxHp: c.max_hp,
        currentMp: c.current_mp,
        maxMp: c.max_mp,
        // Base combat stats
        atk: c.atk,
        def: c.def,
        mo: c.mo,      // Magic Offense
        md: c.md,       // Magic Defense
        speed: c.speed,
        luck: c.luck,
        // Limit break
        limitbreak: parseFloat(c.limitbreak) || 0,
        breaklevel: c.breaklevel || 1,
        // Status effects
        statuses: jp(c.status_effects, []),
        // Equipment info (filled below)
        weaponElements: [],
        weaponStatuses: {},
        armorBlockStatuses: [],
        experience: c.experience || 0
    };

    // 2. Equipment bonuses
    const [equip] = await db.query(`
        SELECT ce.slot_key, gi.* FROM character_equipment ce
        JOIN game_items gi ON ce.item_id = gi.id
        WHERE ce.character_id = ?`, [charId]);

    for (const item of equip) {
        stats.atk += (item.bonus_atk || 0);
        stats.def += (item.bonus_def || 0);
        stats.mo  += (item.bonus_mo || 0);
        stats.md  += (item.bonus_md || 0);
        stats.speed += (item.bonus_speed || 0);
        stats.luck  += (item.bonus_luck || 0);
        stats.maxHp += (item.bonus_hp || 0);
        stats.maxMp += (item.bonus_mp || 0);

        // Weapon elements and statuses
        if (item.slot_key === 'MAIN_HAND' || item.slot_key === 'OFF_HAND') {
            const elems = jp(item.elements, null);
            if (elems) {
                for (const [elemName, role] of Object.entries(elems)) {
                    if (role === 'attack') stats.weaponElements.push(elemName.toLowerCase());
                }
            }
            const ws = jp(item.set_status, null);
            if (ws) Object.assign(stats.weaponStatuses, ws);
        }

        // Armor blocked statuses
        const blocked = jp(item.block_status, null);
        if (blocked) stats.armorBlockStatuses.push(...blocked);
    }

    // 3. Status effect modifiers (ATK Up = multiply ATK by 1.5, etc)
    for (const status of stats.statuses) {
        const [sRows] = await db.query("SELECT * FROM game_statuses WHERE id=?", [status.id]);
        if (!sRows.length) continue;
        const effects = jp(sRows[0].effects, {});
        if (effects.stat_mod) {
            for (const [statKey, multiplier] of Object.entries(effects.stat_mod)) {
                if (stats[statKey] !== undefined && typeof stats[statKey] === 'number') {
                    stats[statKey] = Math.floor(stats[statKey] * multiplier);
                }
            }
        }
    }

    // Clamp HP to max
    if (stats.currentHp > stats.maxHp) stats.currentHp = stats.maxHp;
    if (stats.currentMp > stats.maxMp) stats.currentMp = stats.maxMp;

    return stats;
}

// Build the vars object for safeEval formulas
function buildFormulaVars(attacker, defender) {
    return {
        ATK: attacker.atk,
        DEF: defender.def,
        MO: attacker.mo,
        MD: defender.md,
        SPEED: attacker.speed,
        LUCK: attacker.luck,
        MAXHP: attacker.maxHp,
        MAXMP: attacker.maxMp,
        LVL: attacker.level,
        ENEMY_ATK: defender.atk,
        ENEMY_DEF: defender.def,
        ENEMY_MO: defender.mo,
        ENEMY_MD: defender.md,
        ENEMY_SPEED: defender.speed,
        ENEMY_LUCK: defender.luck,
        ENEMY_MAXHP: defender.maxHp,
        ENEMY_LVL: defender.level
    };
}

// =================================================================
// TABLE COMPATIBILITY HELPERS
// =================================================================
// The project supports two naming conventions depending on which
// SQL migration was run first.  These helpers try the new GPT-style
// name first, then fall back to the original project name so the
// game works regardless of which schema version is installed.

async function queryLevelRow(db, level) {
    for (const tbl of ['level_requirements', 'game_levels']) {
        try {
            const [rows] = await db.query(`SELECT * FROM \`${tbl}\` WHERE level=?`, [level]);
            return rows;
        } catch (e) {
            if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) continue;
            throw e;
        }
    }
    return [];
}

async function queryLimitBreakRow(db, id, classId) {
    for (const tbl of ['game_limit_breaks', 'game_limits']) {
        try {
            const [rows] = await db.query(`SELECT * FROM \`${tbl}\` WHERE id=? AND class_id=?`, [id, classId]);
            return rows;
        } catch (e) {
            if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) continue;
            throw e;
        }
    }
    return [];
}

async function queryLimitBreaksList(db, classId, charLevel, breakLevel) {
    for (const tbl of ['game_limit_breaks', 'game_limits']) {
        try {
            const [rows] = await db.query(
                `SELECT * FROM \`${tbl}\` WHERE class_id=? AND char_level_req<=? AND break_level<=? ORDER BY break_level`,
                [classId, charLevel, breakLevel]
            );
            return rows;
        } catch (e) {
            if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) continue;
            throw e;
        }
    }
    return [];
}

// =================================================================
// BATTLE STATE — In-memory battle tracker
// =================================================================
const activeBattles = {};  // battleId -> BattleState

class BattleState {
    constructor(id, p1Stats, p2Stats, type = 'PVP') {
        this.id = id;
        this.type = type; // PVP or PVE
        this.turnNumber = 1;
        this.turnCharId = null; // Who goes first (determined by speed)
        this.status = 'ACTIVE';
        this.winner = null;
        this.log = [];

        // Combatant snapshots (mutable during battle)
        this.combatants = {
            [p1Stats.charId]: { ...p1Stats, isAI: false },
            [p2Stats.charId]: { ...p2Stats, isAI: type === 'PVE' }
        };

        // Determine first turn by speed (+ luck tiebreaker)
        if (p1Stats.speed + p1Stats.luck * 0.1 >= p2Stats.speed + p2Stats.luck * 0.1) {
            this.turnCharId = p1Stats.charId;
        } else {
            this.turnCharId = p2Stats.charId;
        }
    }

    getOpponent(charId) {
        const ids = Object.keys(this.combatants).map(Number);
        return this.combatants[ids.find(id => id !== charId)];
    }

    getCombatant(charId) {
        return this.combatants[charId];
    }

    addLog(entry) {
        this.log.push({ turn: this.turnNumber, time: Date.now(), ...entry });
    }

    nextTurn() {
        const ids = Object.keys(this.combatants).map(Number);
        this.turnCharId = ids.find(id => id !== this.turnCharId);
        this.turnNumber++;
    }

    toClientState(forCharId) {
        // If viewer is not provided (public view) or not a participant, return a safe public state
        const ids = Object.keys(this.combatants);
        const isValidViewer = forCharId && this.combatants[forCharId];
        if (!isValidViewer) {
            const a = this.combatants[ids[0]];
            const b = this.combatants[ids[1]];
            return {
                battleId: this.id,
                turn: this.turnNumber,
                isMyTurn: false,
                combatants: [
                    { id: a.charId || parseInt(ids[0]), name: a.name, hp: a.currentHp, maxHp: a.maxHp, statuses: a.statuses },
                    { id: b.charId || parseInt(ids[1]), name: b.name, hp: b.currentHp, maxHp: b.maxHp, statuses: b.statuses }
                ],
                status: this.status,
                winner: this.winner,
                log: this.log.slice(-10)
            };
        }

        const me = this.combatants[forCharId];
        const opp = this.getOpponent(forCharId);
        return {
            battleId: this.id,
            turn: this.turnNumber,
            isMyTurn: this.turnCharId === forCharId,
            me: { name: me.name, hp: me.currentHp, maxHp: me.maxHp, mp: me.currentMp, maxMp: me.maxMp, statuses: me.statuses, limitbreak: me.limitbreak, breaklevel: me.breaklevel },
            opponent: { name: opp.name, hp: opp.currentHp, maxHp: opp.maxHp, mp: opp.currentMp, maxMp: opp.maxMp, statuses: opp.statuses },
            status: this.status,
            winner: this.winner,
            log: this.log.slice(-10)
        };
    }
}

// =================================================================
// BATTLE MANAGER — Create, Run, End battles
// =================================================================
const BattleManager = {

    // --- CREATE BATTLE ---
    createBattle: async (db, io, p1Socket, p2Socket, p1CharId, p2CharId, type = 'PVP') => {
        // Get effective stats for both
        const p1Stats = await getEffectiveStats(db, p1CharId);
        const p2Stats = await getEffectiveStats(db, p2CharId);
        if (!p1Stats || !p2Stats) return null;

        // Create DB record
        const [result] = await db.query(
            `INSERT INTO game_battles (p1_char_id, p2_char_id, p1_user_id, p2_user_id, turn_char_id, status)
             VALUES (?,?,?,?,?,?)`,
            [p1CharId, p2CharId, p1Stats.userId, p2Stats.userId,
             p1Stats.speed >= p2Stats.speed ? p1CharId : p2CharId, 'ACTIVE']
        );
        const battleId = result.insertId;

        // Create in-memory state
        const battle = new BattleState(battleId, p1Stats, p2Stats, type);
        activeBattles[battleId] = battle;

        // Get available commands for each player
        const p1Cmds = await getAvailableCommands(db, p1Stats);
        const p2Cmds = await getAvailableCommands(db, p2Stats);

        // Notify both players
        if (p1Socket) {
            p1Socket.emit('battle_start', {
                ...battle.toClientState(p1CharId),
                commands: p1Cmds
            });
        }
        if (p2Socket) {
            p2Socket.emit('battle_start', {
                ...battle.toClientState(p2CharId),
                commands: p2Cmds
            });
        }

        battle.addLog({ actor: 'system', text: `Battle begins! ${p1Stats.name} vs ${p2Stats.name}!` });

        // If P2 is AI and it's AI's turn, auto-act
        if (type === 'PVE' && battle.turnCharId === p2CharId) {
            setTimeout(() => BattleManager.aiTurn(db, io, battleId), 1500);
        }

        return battleId;
    },

    // --- GET AVAILABLE COMMANDS ---
    // Returns the command menu for a combatant (filtered by status effects)
    getAvailableCommands,

    // --- PROCESS PLAYER ACTION ---
    processAction: async (db, io, socket, { battleId, commandId, skillId, itemId, limitId, targetId }) => {
        const battle = activeBattles[battleId];
        if (!battle || battle.status !== 'ACTIVE') {
            socket.emit('battle_error', 'No active battle.');
            return;
        }

        // Find which combatant this socket controls.
        // IMPORTANT: In PvP, *both* combatants are human, so we must use the
        // charId the server attached to the socket when the battle started.
        // In PvE, we can safely fall back to "the non-AI combatant".
        let charId = socket._battleCharId;
        if (!charId || !battle.combatants[charId]) {
            charId = Object.keys(battle.combatants).map(Number)
                .find(id => !battle.combatants[id].isAI);
        }

        if (!charId || battle.turnCharId !== charId) {
            socket.emit('battle_error', 'Not your turn.');
            return;
        }

        const actor = battle.getCombatant(charId);
        const target = battle.getOpponent(charId);

        // Execute the action
        const result = await executeBattleAction(db, battle, actor, target, { commandId, skillId, itemId, limitId });

        // Send result to both players
        await broadcastBattleUpdate(io, battle, result);

        // Check for battle end
        if (battle.status !== 'ACTIVE') {
            await endBattle(db, io, battle);
            return;
        }

        // Process turn-end status effects, then next turn
        await processStatusEffects(db, battle);

        // Check deaths from status effects
        checkDeaths(battle);
        if (battle.status !== 'ACTIVE') {
            await broadcastBattleUpdate(io, battle, { text: 'Battle Over!' });
            await endBattle(db, io, battle);
            return;
        }

        battle.nextTurn();
        await broadcastBattleUpdate(io, battle, null);

        // AI turn
        const nextActor = battle.getCombatant(battle.turnCharId);
        if (nextActor.isAI) {
            setTimeout(() => BattleManager.aiTurn(db, io, battleId), 1200);
        }
    },

    // --- AI TURN ---
    aiTurn: async (db, io, battleId) => {
        const battle = activeBattles[battleId];
        if (!battle || battle.status !== 'ACTIVE') return;

        const ai = battle.getCombatant(battle.turnCharId);
        const player = battle.getOpponent(battle.turnCharId);

        // Simple AI: Attack command (ID 1) or heal if low HP
        let commandId = 1; // Attack
        let skillId = null;

        // If HP below 30%, try to heal (if AI has healing skill — future)
        // For now: just attack with randomness
        if (Math.random() < 0.2) commandId = 2; // Sometimes defend

        const result = await executeBattleAction(db, battle, ai, player, { commandId });
        await broadcastBattleUpdate(io, battle, result);

        if (battle.status !== 'ACTIVE') {
            await endBattle(db, io, battle);
            return;
        }

        await processStatusEffects(db, battle);
        checkDeaths(battle);
        if (battle.status !== 'ACTIVE') {
            await broadcastBattleUpdate(io, battle, { text: 'Battle Over!' });
            await endBattle(db, io, battle);
            return;
        }

        battle.nextTurn();
        await broadcastBattleUpdate(io, battle, null);
    },

    // Expose for server.js
    activeBattles,
    getEffectiveStats
};

// =================================================================
// EXECUTE BATTLE ACTION — The core resolver
// =================================================================
async function executeBattleAction(db, battle, actor, target, { commandId, skillId, itemId, limitId }) {
    const result = { actor: actor.name, actions: [], log: [] };

    // Check if actor is stunned
    for (const s of actor.statuses) {
        const [sRows] = await db.query("SELECT * FROM game_statuses WHERE id=?", [s.id]);
        if (sRows.length) {
            const fx = jp(sRows[0].effects, {});
            if (fx.skip_turn) {
                const logText = (fx.log || '{name} cannot act!').replace('{name}', actor.name);
                result.log.push(logText);
                battle.addLog({ actor: actor.name, action: 'STUNNED', text: logText });
                return result;
            }
        }
    }

    // --- SKILL ---
    if (skillId) {
        return await resolveSkill(db, battle, actor, target, skillId, result);
    }

    // --- ITEM ---
    if (itemId) {
        return await resolveItem(db, battle, actor, target, itemId, result);
    }
    // --- LIMIT BREAK ---
    if (limitId) {
        return await resolveLimitBreak(db, battle, actor, target, limitId, result);
    }


    // --- COMMAND ---
    const [cmdRows] = await db.query("SELECT * FROM game_battle_commands WHERE id=?", [commandId || 1]);
    if (!cmdRows.length) {
        result.log.push(`${actor.name} hesitates...`);
        return result;
    }

    const cmd = cmdRows[0];
    const effects = jp(cmd.effects, {});

    // OPEN MENU commands (Skills, Items) — client handles these, shouldn't reach here
    if (effects.open_menu) {
        result.log.push(`${actor.name} opens ${effects.open_menu} menu.`);
        return result;
    }

    // FLEE
    if (effects.flee) {
        return resolveFlee(battle, actor, target, effects.flee, result);
    }

    // DEFEND
    if (effects.set_status) {
        return resolveSetStatus(db, battle, actor, target, effects, cmd.name, result);
    }

    // ATTACK (damage command)
    if (effects.damage) {
        return await resolveDamage(db, battle, actor, target, effects, cmd.name, result);
    }

    result.log.push(`${actor.name} does nothing.`);
    return result;
}

// --- RESOLVE DAMAGE ---
async function resolveDamage(db, battle, actor, target, effects, actionName, result) {
    const dmgDef = effects.damage;
    const vars = buildFormulaVars(actor, target);

    // Calculate base damage
    let damage = Math.floor(safeEval(dmgDef.formula || 'ATK*2-DEF', vars));

    // Randomize
    if (dmgDef.randomize) {
        const rand = 1 + (Math.random() * 2 - 1) * dmgDef.randomize;
        damage = Math.floor(damage * rand);
    }

    // Critical hit check (luck-based)
    let crit = false;
    if (Math.random() * 100 < (actor.luck || 5)) {
        damage = Math.floor(damage * 1.5);
        crit = true;
    }

    // Element processing
    let elements = [];
    if (effects.apply_weapon_elements && actor.weaponElements.length) {
        elements = [...actor.weaponElements];
    }
    if (effects.elements) {
        elements = [...elements, ...effects.elements];
    }

    // Element weakness bonus
    if (elements.length > 0) {
        const [allElems] = await db.query("SELECT * FROM game_elements");
        for (const elemName of elements) {
            const elem = allElems.find(e => e.name.toLowerCase() === elemName.toLowerCase());
            if (elem && elem.opposite_id) {
                // Check if target has weakness (via equipment elements with 'defense' role or race)
                // For now: flat bonus from element table
                damage = Math.floor(damage * (1 + (elem.bonus_damage_pct || 0) / 100));
            }
        }
    }

    // Defending status halves damage
    const defendingStatus = target.statuses.find(s => s.id === 2 || s.name === 'Defending');
    if (defendingStatus) {
        damage = Math.floor(damage * 0.5);
    }

    // Minimum 1 damage
    damage = Math.max(1, damage);

    // Apply damage
    target.currentHp = Math.max(0, target.currentHp - damage);

    // Log
    const logText = (effects.log || `{name} attacks!`).replace('{name}', actor.name);
    result.log.push(logText);
    result.log.push(`${crit ? '💥 CRITICAL! ' : ''}${target.name} takes ${damage} damage!`);
    result.actions.push({ type: 'damage', target: target.name, amount: damage, crit, elements });

    battle.addLog({ actor: actor.name, action: actionName, damage, crit, target: target.name });

    // Weapon status effects (chance to inflict)
    if (effects.apply_weapon_status && Object.keys(actor.weaponStatuses).length) {
        for (const [statusName, duration] of Object.entries(actor.weaponStatuses)) {
            if (Math.random() < 0.25) { // 25% chance
                await applyStatus(db, target, statusName, duration, result);
            }
        }
    }

    // Skill-based status effects
    if (effects.set_status) {
        await resolveStatusFromEffect(db, battle, actor, target, effects.set_status, result);
    }

    // Limit break fill (defender gains limit from taking damage)
    const fillRate = (damage / target.maxHp) * 100 * 0.5; // Taking damage fills bar
    target.limitbreak = Math.min(100, target.limitbreak + fillRate);

    // Check death
    if (target.currentHp <= 0) {
        battle.status = 'FINISHED';
        battle.winner = actor.charId;
        result.log.push(`${target.name} has been defeated!`);
    }

    return result;
}

// --- RESOLVE SKILL ---
async function resolveSkill(db, battle, actor, target, skillId, result) {
    // Get skill definition
    const [skillRows] = await db.query("SELECT * FROM game_skills WHERE id=?", [skillId]);
    if (!skillRows.length) {
        result.log.push(`${actor.name} tries to cast... nothing.`);
        return result;
    }
    const skill = skillRows[0];

    // Get class-specific MP cost
    const [csRows] = await db.query("SELECT * FROM game_class_skills WHERE class_id=? AND skill_id=?",
        [actor.classId, skillId]);
    const mpCost = csRows.length ? csRows[0].mp_cost : 0;

    // Check MP
    if (actor.currentMp < mpCost) {
        result.log.push(`${actor.name} doesn't have enough MP! (Need ${mpCost})`);
        return result;
    }

    // Deduct MP
    actor.currentMp -= mpCost;

    // Battle text
    const battleText = (skill.battle_text || '{name} uses {skill}!')
        .replace('{name}', actor.name)
        .replace('{skill}', csRows.length && csRows[0].alt_name ? csRows[0].alt_name : skill.name);
    result.log.push(battleText);

    const effects = jp(skill.effects, {});
    const vars = buildFormulaVars(actor, target);

    // OFFENSIVE
    if (effects.damage) {
        let damage = Math.floor(safeEval(effects.damage.formula || 'MO*2-MD', vars));
        if (effects.damage.randomize) {
            damage = Math.floor(damage * (1 + (Math.random() * 2 - 1) * effects.damage.randomize));
        }

        // Skill elements
        const skillElems = jp(skill.elements, []);
        if (skillElems.length) {
            const [allElems] = await db.query("SELECT * FROM game_elements");
            for (const en of skillElems) {
                const elem = allElems.find(e => e.name.toLowerCase() === en.toLowerCase());
                if (elem) damage = Math.floor(damage * (1 + (elem.bonus_damage_pct || 0) / 100));
            }
        }

        damage = Math.max(1, damage);
        target.currentHp = Math.max(0, target.currentHp - damage);
        result.log.push(`${target.name} takes ${damage} damage!`);
        result.actions.push({ type: 'skill_damage', skill: skill.name, target: target.name, amount: damage, elements: skillElems });
        battle.addLog({ actor: actor.name, action: skill.name, damage, target: target.name });

        // Limit fill for defender
        target.limitbreak = Math.min(100, target.limitbreak + (damage / target.maxHp) * 100 * 0.5);
    }

    // HEALING
    if (effects.heal) {
        let heal = Math.floor(safeEval(effects.heal.formula || 'MO*3+50', vars));
        // Target self or ally
        const healTarget = (skill.target_type === 'SELF' || skill.target_type === 'ALLY') ? actor : target;
        healTarget.currentHp = Math.min(healTarget.maxHp, healTarget.currentHp + heal);
        result.log.push(`${healTarget.name} recovers ${heal} HP!`);
        result.actions.push({ type: 'heal', target: healTarget.name, amount: heal });
    }

    // STATUS EFFECTS
    if (effects.set_status) {
        await resolveStatusFromEffect(db, battle, actor, target, effects.set_status, result);
    }

    // CURE STATUSES
    const healStatus = jp(skill.heal_status, []);
    if (healStatus.length) {
        const cureTarget = skill.target_type === 'SELF' ? actor : target;
        cureTarget.statuses = cureTarget.statuses.filter(s => !healStatus.includes(s.id));
        result.log.push(`${cureTarget.name}'s status ailments are cured!`);
    }

    // Check death
    if (target.currentHp <= 0) {
        battle.status = 'FINISHED';
        battle.winner = actor.charId;
        result.log.push(`${target.name} has been defeated!`);
    }

    return result;
}

// --- RESOLVE ITEM ---
async function resolveItem(db, battle, actor, target, itemId, result) {
    // Check inventory
    const [inv] = await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?",
        [actor.charId, itemId]);
    if (!inv.length || inv[0].quantity < 1) {
        result.log.push(`${actor.name} doesn't have that item!`);
        return result;
    }

    // Get item data
    const [itemRows] = await db.query("SELECT * FROM game_items WHERE id=?", [itemId]);
    if (!itemRows.length || itemRows[0].type !== 'CONSUMABLE') {
        result.log.push(`${actor.name} can't use that in battle!`);
        return result;
    }

    const item = itemRows[0];
    const effects = jp(item.effects, {});

    result.log.push(`${actor.name} uses ${item.icon || '🧪'} ${item.name}!`);

    // Heal HP
    if (effects.heal_hp) {
        const vars = buildFormulaVars(actor, target);
        const heal = Math.floor(safeEval(effects.heal_hp.formula || '50', vars));
        actor.currentHp = Math.min(actor.maxHp, actor.currentHp + heal);
        result.log.push(`${actor.name} recovers ${heal} HP!`);
        result.actions.push({ type: 'heal', target: actor.name, amount: heal });
    }

    // Heal MP
    if (effects.heal_mp) {
        const vars = buildFormulaVars(actor, target);
        const heal = Math.floor(safeEval(effects.heal_mp.formula || '30', vars));
        actor.currentMp = Math.min(actor.maxMp, actor.currentMp + heal);
        result.log.push(`${actor.name} recovers ${heal} MP!`);
    }

    // Cure statuses
    if (effects.cure_status) {
        const toCure = Array.isArray(effects.cure_status) ? effects.cure_status : [effects.cure_status];
        actor.statuses = actor.statuses.filter(s => !toCure.includes(s.id));
        result.log.push(`Status cured!`);
    }

    // Consume the item
    if (inv[0].quantity > 1) {
        await db.query("UPDATE character_items SET quantity=quantity-1 WHERE id=?", [inv[0].id]);
    } else {
        await db.query("DELETE FROM character_items WHERE id=?", [inv[0].id]);
    }

    return result;
}

// --- RESOLVE LIMIT BREAK ---
async function resolveLimitBreak(db, battle, actor, target, limitId, result) {
    // Get limit data
    const [limRows] = await queryLimitBreakRow(db, limitId, actor.classId);
    if (!limRows.length) {
        result.log.push(`${actor.name} can't use that limit break!`);
        return result;
    }

    const limit = limRows[0];

    // Check bar is full and break level matches
    if (actor.limitbreak < 100) {
        result.log.push(`Limit break bar not full!`);
        return result;
    }
    if (limit.break_level > actor.breaklevel) {
        result.log.push(`Limit break level too low!`);
        return result;
    }
    if (limit.char_level_req > actor.level) {
        result.log.push(`Character level too low for this limit!`);
        return result;
    }

    // Consume limit bar
    actor.limitbreak = 0;

    const effects = jp(limit.effects, {});
    const vars = buildFormulaVars(actor, target);

    const logText = (effects.log || `{name} unleashes ${limit.name}!`).replace('{name}', actor.name);
    result.log.push(`💥 LIMIT BREAK: ${logText}`);
    result.actions.push({ type: 'limit_break', name: limit.name, icon: limit.icon });

    // Damage
    if (effects.damage) {
        let damage = Math.floor(safeEval(effects.damage.formula || 'ATK*4', vars));
        if (effects.damage.randomize) {
            damage = Math.floor(damage * (1 + (Math.random() * 2 - 1) * effects.damage.randomize));
        }
        damage = Math.max(1, damage);

        // Apply to target(s)
        if (limit.target_type === 'ALL_ENEMIES' || limit.target_type === 'ALL') {
            // In 1v1, this is the same as ENEMY
            target.currentHp = Math.max(0, target.currentHp - damage);
        } else {
            target.currentHp = Math.max(0, target.currentHp - damage);
        }
        result.log.push(`${target.name} takes ${damage} damage!`);
        result.actions.push({ type: 'limit_damage', target: target.name, amount: damage });
    }

    // Heal
    if (effects.heal) {
        const heal = Math.floor(safeEval(effects.heal.formula || 'MAXHP*0.3', vars));
        actor.currentHp = Math.min(actor.maxHp, actor.currentHp + heal);
        result.log.push(`${actor.name} recovers ${heal} HP!`);
    }

    // Status
    if (effects.set_status) {
        await resolveStatusFromEffect(db, battle, actor, target, effects.set_status, result);
    }

    // Check death
    if (target.currentHp <= 0) {
        battle.status = 'FINISHED';
        battle.winner = actor.charId;
        result.log.push(`${target.name} has been defeated!`);
    }

    return result;
}

// --- RESOLVE FLEE ---
function resolveFlee(battle, actor, target, fleeDef, result) {
    const vars = buildFormulaVars(actor, target);
    const check = safeEval(fleeDef.formula || 'SPEED+LUCK*0.5-ENEMY_SPEED', vars);

    if (check > 0 || Math.random() < 0.3) { // Speed advantage or 30% base chance
        battle.status = 'FLED';
        battle.winner = null; // No winner on flee
        const logText = (fleeDef.log_success || '{name} escapes!').replace('{name}', actor.name);
        result.log.push(logText);
    } else {
        const logText = (fleeDef.log_fail || "{name} couldn't escape!").replace('{name}', actor.name);
        result.log.push(logText);
    }
    return result;
}

// --- RESOLVE SET STATUS (from commands like Defend) ---
async function resolveSetStatus(db, battle, actor, target, effects, actionName, result) {
    const logText = (effects.log || `{name} uses ${actionName}!`).replace('{name}', actor.name);
    result.log.push(logText);

    if (effects.set_status) {
        await resolveStatusFromEffect(db, battle, actor, target, effects.set_status, result);
    }
    return result;
}

// --- APPLY STATUS FROM EFFECT JSON ---
async function resolveStatusFromEffect(db, battle, actor, target, statusEffect, result) {
    const setTarget = statusEffect.target === 'self' ? actor : target;
    const chance = statusEffect.chance || 100;
    const statuses = statusEffect.statuses || {};

    for (const [statusName, duration] of Object.entries(statuses)) {
        // Chance check
        if (Math.random() * 100 > chance) continue;

        // Check if armor blocks this status
        if (setTarget.armorBlockStatuses.length) {
            const [sRow] = await db.query("SELECT id FROM game_statuses WHERE name=?", [statusName]);
            if (sRow.length && setTarget.armorBlockStatuses.includes(sRow[0].id)) {
                result.log.push(`${setTarget.name}'s armor blocks ${statusName}!`);
                continue;
            }
        }

        await applyStatus(db, setTarget, statusName, duration, result);
    }
}

// --- APPLY A SINGLE STATUS ---
async function applyStatus(db, target, statusName, duration, result) {
    // Look up by name (case insensitive)
    const [sRows] = await db.query("SELECT * FROM game_statuses WHERE LOWER(name)=LOWER(?)", [statusName]);
    if (!sRows.length) return;

    const status = sRows[0];

    // Check if already has this status
    const existing = target.statuses.findIndex(s => s.id === status.id);
    if (existing >= 0) {
        // Refresh duration
        target.statuses[existing].turns = duration || status.default_duration;
    } else {
        target.statuses.push({
            id: status.id,
            name: status.name,
            icon: status.icon,
            turns: duration || status.default_duration
        });
        result.log.push(`${target.name} is afflicted with ${status.icon} ${status.name}!`);
    }
}

// =================================================================
// STATUS EFFECTS — End-of-turn processing
// =================================================================
async function processStatusEffects(db, battle) {
    // Process for BOTH combatants at end of each full round
    for (const charId of Object.keys(battle.combatants)) {
        const c = battle.combatants[charId];
        const toRemove = [];

        // Sort by priority (higher first)
        const sortedStatuses = [...c.statuses];

        for (let i = 0; i < sortedStatuses.length; i++) {
            const s = sortedStatuses[i];
            const [sRows] = await db.query("SELECT * FROM game_statuses WHERE id=?", [s.id]);
            if (!sRows.length) { toRemove.push(i); continue; }

            const effects = jp(sRows[0].effects, {});

            // Damage per turn (Poison, Burn)
            if (effects.damage_per_turn) {
                const vars = { MAXHP: c.maxHp, MO: c.mo, LVL: c.level, ATK: c.atk };
                const dmg = Math.max(1, Math.floor(safeEval(effects.damage_per_turn.formula || '10', vars)));
                c.currentHp = Math.max(0, c.currentHp - dmg);
                const logText = (effects.log || `{name} takes ${dmg} status damage!`).replace('{name}', c.name);
                battle.addLog({ actor: 'status', text: logText });
            }

            // Heal per turn (Regen)
            if (effects.heal_per_turn) {
                const vars = { MAXHP: c.maxHp, MO: c.mo, LVL: c.level, MLVL: c.level };
                const heal = Math.floor(safeEval(effects.heal_per_turn.formula || '20', vars));
                c.currentHp = Math.min(c.maxHp, c.currentHp + heal);
                const logText = (effects.log || `{name} regenerates.`).replace('{name}', c.name);
                battle.addLog({ actor: 'status', text: logText });
            }

            // Decrement duration
            s.turns--;
            if (s.turns <= 0 && !sRows[0].permanent) {
                toRemove.push(i);
                battle.addLog({ actor: 'status', text: `${s.icon} ${s.name} wears off ${c.name}.` });
            }
        }

        // Remove expired statuses
        c.statuses = c.statuses.filter((_, i) => !toRemove.includes(i));
    }
}

function checkDeaths(battle) {
    for (const [charId, c] of Object.entries(battle.combatants)) {
        if (c.currentHp <= 0) {
            battle.status = 'FINISHED';
            const oppId = Object.keys(battle.combatants).find(id => id !== charId);
            battle.winner = parseInt(oppId);
        }
    }
}

// =================================================================
// END BATTLE — Save results, give rewards
// =================================================================
async function endBattle(db, io, battle) {
    // Update DB record
    await db.query("UPDATE game_battles SET status=?, winner_char_id=?, battle_log=? WHERE id=?",
        [battle.status, battle.winner, JSON.stringify(battle.log), battle.id]);

    // Sync HP/MP/Limit/Statuses back to characters table
    for (const [charId, c] of Object.entries(battle.combatants)) {
        await db.query(
            `UPDATE characters SET current_hp=?, current_mp=?, limitbreak=?, status_effects=? WHERE id=?`,
            [Math.max(0, c.currentHp), Math.max(0, c.currentMp), c.limitbreak,
             JSON.stringify(c.statuses), charId]
        );
    }

    // =============================================================
    // LEGENDARY ARTIFACTS HOOK (OPTIONAL)
    // =============================================================
    // If you have routes/artifactRoutes.js with onPvpKill(), this makes
    // artifacts "come alive" automatically when a PvP kill happens.
    // It is wrapped in try/catch so missing modules never break battles.
    if (
        battle.type === 'PVP' &&
        battle.status === 'FINISHED' &&
        battle.winner &&
        artifactRoutes &&
        typeof artifactRoutes.onPvpKill === 'function'
    ) {
        const loserId = Object.keys(battle.combatants).map(Number)
            .find(id => id !== battle.winner);

        if (loserId) {
            try {
                // Pull a tiny bit of context (location) for logging / future features.
                const [posRows] = await db.query(
                    "SELECT id, map_id, x, y FROM characters WHERE id IN (?,?)",
                    [battle.winner, loserId]
                );
                const posById = {};
                for (const r of posRows) posById[r.id] = r;

                const hookRes = await artifactRoutes.onPvpKill(
                    battle.winner,
                    loserId,
                    {
                        location: {
                            mapId: posById[battle.winner]?.map_id ?? null,
                            x: posById[battle.winner]?.x ?? null,
                            y: posById[battle.winner]?.y ?? null
                        },
                        timestamp: Date.now(),
                        // Your PvP challenges are basically "duels" right now.
                        // Set to false so artifacts can transfer in normal PvP.
                        // If you later add a duel ladder, you can set this true there.
                        isDuel: false
                    }
                );

                // Optional broadcast: clients may listen for this to show global announcements.
                if (hookRes && hookRes.transferred && io && typeof io.emit === 'function') {
                    io.emit('artifact_transfer', hookRes);
                }
            } catch (e) {
                console.error('Artifact onPvpKill hook failed:', e);
            }
        }
    }

    // Give rewards to winner
    if (battle.winner && battle.status === 'FINISHED') {
        const winner = battle.combatants[battle.winner];
        const loser = battle.getOpponent(battle.winner);

        // Look up level table for loser's level
        const [lvlRows] = await queryLevelRow(db, loser.level);
        if (lvlRows.length) {
            const lv = lvlRows[0];
            const xpReward = lv.xp_for_win || 0;
            const goldReward = lv.gold_for_win || 0;

            // Give XP — write to BOTH stores so they stay in sync:
            //   characters.experience = cumulative historical total (display/reference)
            //   state_json.xp         = XP within current level (progression system source of truth)
            if (xpReward) {
                await db.query('UPDATE characters SET experience = experience + ? WHERE id = ?', [xpReward, battle.winner]);
                // Sync state_json.xp using MySQL JSON_SET
                await db.query(
                    `UPDATE characters SET state_json = JSON_SET(COALESCE(state_json,'{}'),'$.xp',
                     COALESCE(CAST(JSON_EXTRACT(state_json,'$.xp') AS DECIMAL(20,0)),0)+?) WHERE id=?`,
                    [xpReward, battle.winner]
                );
                // Use state_json-aware level-up (not the broken cumulative comparison)
                await checkLevelUpStateJson(db, battle.winner);
            }

            // Give Gold
            if (goldReward) {
                await db.query("UPDATE users SET currency=currency+? WHERE id=?",
                    [goldReward, winner.userId]);
            }

            // Update battle record
            await db.query(`UPDATE characters SET battle_record=JSON_SET(battle_record,'$.W',CAST(JSON_EXTRACT(battle_record,'$.W')+1 AS UNSIGNED)) WHERE id=?`, [battle.winner]);
            const loserId = Object.keys(battle.combatants).find(id => parseInt(id) !== battle.winner);
            await db.query(`UPDATE characters SET battle_record=JSON_SET(battle_record,'$.L',CAST(JSON_EXTRACT(battle_record,'$.L')+1 AS UNSIGNED)) WHERE id=?`, [loserId]);
        }
    }

    // Clean up memory
    delete activeBattles[battle.id];
}

// =================================================================
// LEVEL UP CHECK (state_json-aware version)
// =================================================================
// Teaching: The old checkLevelUp compared cumulative characters.experience
// to per-level xp_required, which is wrong — a level 10 char with 5000
// total XP always has >= 100 (level 2 requirement) so would loop forever.
// The fix: read state_json.xp (XP within current level, decremented on
// each level-up by the progression system) and compare that instead.
// We also apply HP/MP growth here just like the old version did.
async function checkLevelUpStateJson(db, charId) {
    const [rows] = await db.query(
        'SELECT level, max_hp, max_mp, state_json FROM characters WHERE id=?', [charId]
    );
    if (!rows.length) return;
    const c = rows[0];
    let state = {};
    try { state = JSON.parse(c.state_json || '{}'); } catch {}
    if (typeof state.xp !== 'number') state.xp = 0;
    if (!state.progression) state.progression = { unspent_points: 0 };

    let level = c.level || 1;
    let maxHp = c.max_hp;
    let maxMp = c.max_mp;
    let leveled = false;

    // Level up loop — capped at 50 for safety
    for (let i = 0; i < 50; i++) {
        const nextRows = await queryLevelRow(db, level + 1);
        if (!nextRows.length) break; // max level
        const next = nextRows[0];
        if (state.xp < (next.xp_required || 0)) break;

        // Consume XP and level up
        state.xp -= next.xp_required;
        level++;
        maxHp += (next.hp_growth || 0);
        maxMp += (next.mp_growth || 0);
        state.progression.unspent_points = (state.progression.unspent_points || 0) + 3;
        state.progression.last_level_up_at = new Date().toISOString();
        leveled = true;
    }

    if (leveled) {
        await db.query(
            'UPDATE characters SET level=?, max_hp=?, current_hp=?, max_mp=?, current_mp=?, state_json=? WHERE id=?',
            [level, maxHp, maxHp, maxMp, maxMp, JSON.stringify(state), charId]
        );
    } else if (state.xp !== (rows[0].state_xp)) {
        // Just save updated state_json (XP synced, no level change)
        await db.query('UPDATE characters SET state_json=? WHERE id=?', [JSON.stringify(state), charId]);
    }
}

// Keep old function name as alias so existing calls don't break
async function checkLevelUp(db, charId) {
    return checkLevelUpStateJson(db, charId);
}

// =================================================================
// HELPERS
// =================================================================
async function getAvailableCommands(db, stats) {
    // Get default commands
    const [defaults] = await db.query("SELECT * FROM game_battle_commands WHERE is_default=1 ORDER BY display_order");

    // Get class-specific commands
    const [classRow] = await db.query("SELECT battle_cmds FROM game_classes WHERE id=?", [stats.classId]);
    let extraCmds = [];
    if (classRow.length) {
        const extraIds = jp(classRow[0].battle_cmds, []);
        if (extraIds.length) {
            const [extras] = await db.query("SELECT * FROM game_battle_commands WHERE id IN (?) ORDER BY display_order", [extraIds]);
            extraCmds = extras;
        }
    }

    // Get available skills for this class at this level
    const [skills] = await db.query(`
        SELECT gs.*, gcs.mp_cost, gcs.alt_name FROM game_class_skills gcs
        JOIN game_skills gs ON gcs.skill_id = gs.id
        WHERE gcs.class_id = ? AND gcs.learn_level <= ?
        ORDER BY gcs.learn_level`, [stats.classId, stats.level]);

    // Get available limit breaks
    const limits = await queryLimitBreaksList(db, stats.classId, stats.level, stats.breaklevel);

    // Get consumable items
    const [items] = await db.query(`
        SELECT gi.*, ci.quantity FROM character_items ci
        JOIN game_items gi ON ci.item_id = gi.id
        WHERE ci.character_id = ? AND gi.type = 'CONSUMABLE'`,
        [stats.charId]);

    // Filter out disabled commands (from status effects)
    let disabledCmds = [];
    for (const s of stats.statuses) {
        const [sRows] = await db.query("SELECT disabled_commands FROM game_statuses WHERE id=?", [s.id]);
        if (sRows.length) {
            const disabled = jp(sRows[0].disabled_commands, []);
            if (disabled.includes(-1)) disabledCmds = [-1]; // -1 = all disabled
            else disabledCmds.push(...disabled);
        }
    }

    const cmds = [...defaults, ...extraCmds].map(c => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        description: c.description,
        targetType: c.target_type,
        disabled: disabledCmds.includes(-1) || disabledCmds.includes(c.id)
    }));

    return {
        commands: cmds,
        skills: skills.map(s => ({
            id: s.id,
            name: s.alt_name || s.name,
            icon: s.icon,
            mpCost: s.mp_cost,
            type: s.type,
            targetType: s.target_type,
            description: s.description
        })),
        limits: limits.map(l => ({
            id: l.id,
            name: l.name,
            icon: l.icon,
            breakLevel: l.break_level,
            targetType: l.target_type,
            description: l.description
        })),
        items: items.map(i => ({
            id: i.id,
            name: i.name,
            icon: i.icon,
            quantity: i.quantity
        }))
    };
}

// In battle_engine.js

// -----------------------------------------------------------------
// BROADCAST UPDATE (Fixed)
// -----------------------------------------------------------------
async function broadcastBattleUpdate(io, battle, actionResult) {
    const room = `battle_${battle.id}`;

    // Best UX: each player gets a personalized state (me/opponent/isMyTurn).
    // Socket.IO v4 supports fetchSockets() for room members.
    try {
        const sockets = await io.in(room).fetchSockets();
        if (sockets && sockets.length) {
            for (const s of sockets) {
                const viewerCharId = s._battleCharId;
                const state = battle.toClientState(viewerCharId);
                s.emit('battle_update', { state, action: actionResult || null });
            }
            return;
        }
    } catch (e) {
        // Fall through to the public update.
    }

    // Safe fallback: public state to everyone in the room.
    const publicState = battle.toClientState(null);
    io.to(room).emit('battle_update', { state: publicState, action: actionResult || null });
}

module.exports = BattleManager;
