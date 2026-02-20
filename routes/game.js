const express = require('express');
const router = express.Router();
let db;
router.init = (c) => { db = c; };
function jp(s, f) { try { return JSON.parse(s); } catch { return f; } }
async function verifyOwnership(userId, charId) {
    const [r] = await db.query('SELECT id FROM characters WHERE id=? AND user_id=?',[charId,userId]);
    return r.length > 0;
}

router.get('/creation-data', async (req, res) => {
    try {
        const [classes]=await db.query("SELECT * FROM game_classes WHERE hidden=0");
        const [races]=await db.query("SELECT * FROM game_races WHERE hidden=0");
        const [backgrounds]=await db.query("SELECT * FROM game_backgrounds");
        const [feats]=await db.query("SELECT * FROM game_feats");
        const [settingsRows]=await db.query("SELECT * FROM system_settings");
        const config = {};
        settingsRows.forEach(r => { config[r.setting_key] = r.setting_value==='true'?true:r.setting_value==='false'?false:r.setting_value; });
        res.json({ success:true, config, data:{classes,races,backgrounds,feats} });
    } catch(e) { res.json({success:false,message:'Server error.'}); }
});

router.post('/my-characters', async (req, res) => {
    try {
        const [rows]=await db.query(`SELECT c.id,c.name,c.level,c.current_hp,c.max_hp,c.current_mp,c.max_mp,c.atk,c.def,c.mo,c.md,c.speed,c.luck,c.map_id,c.x,c.y,c.experience,cl.name as class_name,r.name as race_name FROM characters c JOIN game_classes cl ON c.class_id=cl.id JOIN game_races r ON c.race_id=r.id WHERE c.user_id=?`,[req.body.userId]);
        res.json({count:rows.length,characters:rows});
    } catch { res.json({count:0,characters:[]}); }
});

router.post('/create-character', async (req, res) => {
    const {userId,name,raceId,classId,backgroundId,featId}=req.body;
    if(!name||!name.trim()) return res.json({success:false,message:"Name required."});
    try {
        const [taken]=await db.query("SELECT id FROM characters WHERE name=?",[name.trim()]);
        if(taken.length) return res.json({success:false,message:"Name taken."});
        const [sR]=await db.query("SELECT setting_value FROM system_settings WHERE setting_key='max_characters_per_user'");
        const max=sR.length?parseInt(sR[0].setting_value):3;
        const [ex]=await db.query("SELECT COUNT(*) as cnt FROM characters WHERE user_id=?",[userId]);
        if(ex[0].cnt>=max) return res.json({success:false,message:`Max ${max} characters.`});
        const [cR]=await db.query("SELECT * FROM game_classes WHERE id=?",[classId]);
        const [rR]=await db.query("SELECT * FROM game_races WHERE id=?",[raceId]);
        if(!cR.length||!rR.length) return res.json({success:false,message:"Invalid class/race."});
        const c=cR[0],r=rR[0];
        let bg={bonus_hp:0,bonus_mp:0};
        if(backgroundId>0){const [bR]=await db.query("SELECT * FROM game_backgrounds WHERE id=?",[backgroundId]);if(bR.length)bg=bR[0];}
        const hp=(c.base_hp||100)+(r.bonus_hp||0)+(bg.bonus_hp||0);
        const mp=(c.base_mp||50)+(r.bonus_mp||0)+(bg.bonus_mp||0);
        const atk=(c.base_atk||10)+(r.bonus_atk||0);
        const def=(c.base_def||5)+(r.bonus_def||0);
        const mo=(c.base_mo||5)+(r.bonus_mo||0);
        const md=(c.base_md||5)+(r.bonus_md||0);
        const spd=(c.base_speed||10)+(r.bonus_speed||0);
        const lck=(c.base_luck||5)+(r.bonus_luck||0);
        const [result]=await db.query(`INSERT INTO characters (user_id,name,race_id,class_id,background_id,feat_id,current_hp,max_hp,current_mp,max_mp,atk,def,mo,md,speed,luck,level,experience,map_id,x,y,state_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,1,10,10,'{}')`,
            [userId,name.trim(),raceId,classId,backgroundId||0,featId||0,hp,hp,mp,mp,atk,def,mo,md,spd,lck]);
        const newId=result.insertId;
        const [statDefs]=await db.query("SELECT * FROM game_stat_definitions");
        for(const s of statDefs) await db.query("INSERT INTO character_stats(character_id,stat_key,current_value,max_value)VALUES(?,?,?,?)",[newId,s.key_name,s.default_value,s.default_value]);
        res.json({success:true,message:"Character created!"});
    } catch(e) { console.error(e); res.json({success:false,message:"Server error."}); }
});

router.post('/get-map', async (req, res) => {
    try {
        const [rows]=await db.query("SELECT * FROM game_maps WHERE id=?",[req.body.mapId]);
        if(!rows.length) return res.json({success:true,map:{id:0,name:"The Void",width:20,height:20,tiles:[],events:[]}});
        const m=rows[0];
        res.json({success:true,map:{id:m.id,name:m.name,width:m.width,height:m.height,tiles:jp(m.tiles_json,[]),events:jp(m.collisions_json,[])}});
    } catch(e) { res.json({success:false,message:"Database error."}); }
});

router.post('/save-state', async (req, res) => {
    const {userId,charId,state}=req.body;
    try {
        const [r]=await db.query("UPDATE characters SET state_json=? WHERE id=? AND user_id=?",[JSON.stringify(state),charId,userId]);
        if(r.affectedRows===0) return res.json({success:false,message:"Unauthorized."});
        res.json({success:true});
    } catch { res.json({success:false}); }
});

router.post('/load-state', async (req, res) => {
    const {userId,charId}=req.body;
    try {
        const [r]=await db.query("SELECT state_json FROM characters WHERE id=? AND user_id=?",[charId,userId]);
        if(!r.length) return res.json({success:false,message:"Unauthorized."});
        res.json({success:true,state:jp(r[0].state_json,{})});
    } catch { res.json({success:false}); }
});

router.post('/equip-item', async (req, res) => {
    const {userId,charId,itemId,slotKey}=req.body;
    try {
        if(!await verifyOwnership(userId,charId)) return res.json({success:false,message:'Unauthorized.'});
        const [inv]=await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?",[charId,itemId]);
        if(!inv.length) return res.json({success:false,message:'Item not in inventory.'});
        const [itemR]=await db.query("SELECT * FROM game_items WHERE id=?",[itemId]);
        if(!itemR.length) return res.json({success:false,message:'Item not found.'});
        if(itemR[0].slot!==slotKey&&itemR[0].slot!=='ANY') return res.json({success:false,message:`Goes in ${itemR[0].slot}.`});
        const [cur]=await db.query("SELECT * FROM character_equipment WHERE character_id=? AND slot_key=?",[charId,slotKey]);
        if(cur.length){
            await db.query("INSERT INTO character_items(character_id,item_id,quantity)VALUES(?,?,1)",[charId,cur[0].item_id]);
            await db.query("DELETE FROM character_equipment WHERE character_id=? AND slot_key=?",[charId,slotKey]);
        }
        await db.query("INSERT INTO character_equipment(character_id,slot_key,item_id)VALUES(?,?,?)",[charId,slotKey,itemId]);
        if(inv[0].quantity>1) await db.query("UPDATE character_items SET quantity=quantity-1 WHERE id=?",[inv[0].id]);
        else await db.query("DELETE FROM character_items WHERE id=?",[inv[0].id]);
        res.json({success:true,message:'Equipped!'});
    } catch(e) { console.error(e); res.json({success:false,message:'Server error.'}); }
});

router.post('/unequip-item', async (req, res) => {
    const {userId,charId,slotKey}=req.body;
    try {
        if(!await verifyOwnership(userId,charId)) return res.json({success:false,message:'Unauthorized.'});
        const [eq]=await db.query("SELECT * FROM character_equipment WHERE character_id=? AND slot_key=?",[charId,slotKey]);
        if(!eq.length) return res.json({success:false,message:'Nothing there.'});
        await db.query("INSERT INTO character_items(character_id,item_id,quantity)VALUES(?,?,1)",[charId,eq[0].item_id]);
        await db.query("DELETE FROM character_equipment WHERE character_id=? AND slot_key=?",[charId,slotKey]);
        res.json({success:true,message:'Unequipped.'});
    } catch(e) { res.json({success:false,message:'Server error.'}); }
});

router.post('/get-shop', async (req, res) => {
    try {
        const [shop]=await db.query("SELECT * FROM game_shops WHERE id=?",[req.body.shopId]);
        if(!shop.length) return res.json({success:false,message:"Shop not found."});
        const [supplies]=await db.query("SELECT ss.*,gi.name,gi.description,gi.type,gi.icon,gi.slot FROM game_shop_supplies ss JOIN game_items gi ON ss.item_id=gi.id WHERE ss.shop_id=?",[req.body.shopId]);
        res.json({success:true,shop:shop[0],supplies});
    } catch { res.json({success:false}); }
});

router.post('/buy-item', async (req, res) => {
    const {userId,charId,shopId,itemId}=req.body;const qty=parseInt(req.body.quantity)||1;
    try {
        if(!await verifyOwnership(userId,charId)) return res.json({success:false,message:'Unauthorized.'});
        const [sup]=await db.query("SELECT * FROM game_shop_supplies WHERE shop_id=? AND item_id=?",[shopId,itemId]);
        if(!sup.length) return res.json({success:false,message:"Not for sale."});
        const cost=sup[0].buy_price*qty;
        const [user]=await db.query("SELECT currency FROM users WHERE id=?",[userId]);
        if(!user.length||user[0].currency<cost) return res.json({success:false,message:`Need ${cost}g.`});
        await db.query("UPDATE users SET currency=currency-? WHERE id=?",[cost,userId]);
        const [ex]=await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?",[charId,itemId]);
        if(ex.length) await db.query("UPDATE character_items SET quantity=quantity+? WHERE id=?",[qty,ex[0].id]);
        else await db.query("INSERT INTO character_items(character_id,item_id,quantity)VALUES(?,?,?)",[charId,itemId,qty]);
        if(sup[0].stock>=0) await db.query("UPDATE game_shop_supplies SET stock=stock-? WHERE shop_id=? AND item_id=?",[qty,shopId,itemId]);
        res.json({success:true,message:`Bought ${qty}x for ${cost}g!`});
    } catch(e) { console.error(e); res.json({success:false,message:"Server error."}); }
});

// --- SELL ITEM ---
router.post('/sell-item', async (req, res) => {
    const {userId,charId,itemId}=req.body;const qty=parseInt(req.body.quantity)||1;
    try {
        if(!await verifyOwnership(userId,charId)) return res.json({success:false,message:'Unauthorized.'});
        const [inv]=await db.query("SELECT * FROM character_items WHERE character_id=? AND item_id=?",[charId,itemId]);
        if(!inv.length||inv[0].quantity<qty) return res.json({success:false,message:'Not enough items.'});
        const [itemR]=await db.query("SELECT value FROM game_items WHERE id=?",[itemId]);
        if(!itemR.length) return res.json({success:false,message:'Item not found.'});
        const sellPrice=Math.floor((itemR[0].value||0)*0.5)*qty; // 50% of value
        await db.query("UPDATE users SET currency=currency+? WHERE id=?",[sellPrice,userId]);
        if(inv[0].quantity>qty) await db.query("UPDATE character_items SET quantity=quantity-? WHERE id=?",[qty,inv[0].id]);
        else await db.query("DELETE FROM character_items WHERE id=?",[inv[0].id]);
        res.json({success:true,message:`Sold for ${sellPrice}g!`});
    } catch(e) { res.json({success:false,message:'Server error.'}); }
});

// --- GET FULL CHARACTER DATA (inventory, equipment, stats, progression) ---
router.post('/get-char-full', async (req, res) => {
    const {userId,charId}=req.body;
    try {
        if(!await verifyOwnership(userId,charId)) return res.json({success:false,message:'Unauthorized.'});

        // Full character row + class + race + background names in one query
        const [charR]=await db.query(`
            SELECT c.*,
                   cl.name AS class_name, cl.description AS class_desc,
                   r.name  AS race_name,  r.description  AS race_desc,
                   bg.name AS bg_name,    bg.description AS bg_desc,
                   ft.name AS feat_name,  ft.description AS feat_desc
            FROM characters c
            LEFT JOIN game_classes     cl ON c.class_id      = cl.id
            LEFT JOIN game_races        r ON c.race_id        = r.id
            LEFT JOIN game_backgrounds bg ON c.background_id  = bg.id
            LEFT JOIN game_feats        ft ON c.feat_id        = ft.id
            WHERE c.id = ?`,[charId]);
        if(!charR.length) return res.json({success:false,message:'Not found.'});
        const c=charR[0];

        // Inventory
        const [inv]=await db.query(`SELECT ci.*, gi.name, gi.icon, gi.type, gi.slot, gi.description, gi.value,
            gi.bonus_hp, gi.bonus_mp, gi.bonus_atk, gi.bonus_def, gi.bonus_mo, gi.bonus_md, gi.bonus_speed, gi.bonus_luck,
            gi.level_req, gi.elements, gi.set_status
            FROM character_items ci JOIN game_items gi ON ci.item_id=gi.id WHERE ci.character_id=?`,[charId]);

        // Equipment
        const [equip]=await db.query(`SELECT ce.slot_key, gi.* FROM character_equipment ce
            JOIN game_items gi ON ce.item_id=gi.id WHERE ce.character_id=?`,[charId]);

        // Equip slots
        const [slots]=await db.query("SELECT * FROM game_equip_slots ORDER BY display_order");

        // Gold
        const [userR]=await db.query("SELECT currency FROM users WHERE id=?",[userId]);
        const gold=userR.length?userR[0].currency:0;

        // Skills learned by this class up to current level
        const [skills]=await db.query(`SELECT gs.*, gcs.mp_cost, gcs.alt_name, gcs.learn_level
            FROM game_class_skills gcs
            JOIN game_skills gs ON gcs.skill_id=gs.id
            WHERE gcs.class_id=? AND gcs.learn_level<=?
            ORDER BY gcs.learn_level`,[c.class_id,c.level]);

        // Next level XP — try both table names (schema compatibility)
        let xpToNext=null, xpCurrent=0;
        for(const tbl of ['level_requirements','game_levels']){
            try{
                const [nxt]=await db.query(`SELECT xp_required FROM \`${tbl}\` WHERE level=?`,[c.level+1]);
                if(nxt.length){ xpToNext=nxt[0].xp_required; break; }
            }catch(e){ if(e.code!=='ER_NO_SUCH_TABLE'&&e.errno!==1146) throw e; }
        }

        // XP from state_json (used by progressionRoutes) — fall back to characters.experience
        const stateJson=jp(c.state_json||'{}',{});
        xpCurrent = typeof stateJson.xp==='number' ? stateJson.xp : (c.experience||0);
        const unspentPoints = stateJson.progression?.unspent_points ?? 0;

        // Battle record
        let battleRecord={W:0,L:0,T:0};
        try{ battleRecord=typeof c.battle_record==='object'?c.battle_record:jp(c.battle_record||'{}',{}); }catch{}

        // Limit breaks available
        const [limits]=await (async()=>{
            for(const tbl of ['game_limit_breaks','game_limits']){
                try{
                    return await db.query(`SELECT * FROM \`${tbl}\` WHERE class_id=? AND char_level_req<=? AND break_level<=? ORDER BY break_level`,
                        [c.class_id,c.level,c.breaklevel||1]);
                }catch(e){ if(e.code!=='ER_NO_SUCH_TABLE'&&e.errno!==1146) throw e; }
            }
            return [[]];
        })();

        // Equipment bonus totals
        let eqBonus={hp:0,mp:0,atk:0,def:0,mo:0,md:0,speed:0,luck:0};
        equip.forEach(i=>{
            eqBonus.hp+=(i.bonus_hp||0); eqBonus.mp+=(i.bonus_mp||0);
            eqBonus.atk+=(i.bonus_atk||0); eqBonus.def+=(i.bonus_def||0);
            eqBonus.mo+=(i.bonus_mo||0);   eqBonus.md+=(i.bonus_md||0);
            eqBonus.speed+=(i.bonus_speed||0); eqBonus.luck+=(i.bonus_luck||0);
        });

        res.json({
            success:true,
            character:c,
            inventory:inv,
            equipment:equip,
            slots,
            gold,
            skills,
            limits,
            xpToNext,
            xpCurrent,
            unspentPoints,
            battleRecord,
            equipBonus:eqBonus,
            effectiveStats:{
                maxHp:c.max_hp+eqBonus.hp,   maxMp:c.max_mp+eqBonus.mp,
                atk:c.atk+eqBonus.atk,        def:c.def+eqBonus.def,
                mo:c.mo+eqBonus.mo,            md:c.md+eqBonus.md,
                speed:c.speed+eqBonus.speed,   luck:c.luck+eqBonus.luck,
                limitbreak: parseFloat(c.limitbreak||0),
                breaklevel: c.breaklevel||1
            }
        });
    } catch(e) { console.error(e); res.json({success:false,message:'Server error.'}); }
});

// --- USE ITEM (consumables out of battle) ---
// Teaching: consumable items in game_items use bonus_hp / bonus_mp fields
// for healing, same as equipment — but instead of persisting to equipment,
// we apply the effect immediately to current_hp/current_mp and consume the item.
// Items can also have a stats_json with { heal_hp, restore_mp, heal_pct } for
// more complex effects. We check both so the system is forward-compatible.
router.post('/use-item', async (req, res) => {
    const { userId, charId, itemId } = req.body;
    try {
        if (!await verifyOwnership(userId, charId)) return res.json({ success: false, message: 'Unauthorized.' });

        // Get item from inventory
        const [inv] = await db.query(
            'SELECT ci.*, gi.name, gi.type, gi.icon, gi.bonus_hp, gi.bonus_mp, gi.stats_json FROM character_items ci JOIN game_items gi ON ci.item_id=gi.id WHERE ci.character_id=? AND ci.item_id=?',
            [charId, itemId]
        );
        if (!inv.length) return res.json({ success: false, message: 'Item not in inventory.' });
        const item = inv[0];
        if (item.type !== 'CONSUMABLE') return res.json({ success: false, message: 'This item cannot be used outside of battle.' });

        // Parse stats_json for extended effects
        let stats = {};
        try { stats = JSON.parse(item.stats_json || '{}'); } catch {}

        // Determine healing amounts
        const healHp = (item.bonus_hp || 0) + (stats.heal_hp || 0);
        const healMp = (item.bonus_mp || 0) + (stats.restore_mp || 0);

        // Get current character state
        const [charRows] = await db.query('SELECT current_hp, max_hp, current_mp, max_mp FROM characters WHERE id=?', [charId]);
        if (!charRows.length) return res.json({ success: false, message: 'Character not found.' });
        const c = charRows[0];

        // Calculate percentage heals (e.g. heal_pct: 0.25 = 25% of max HP)
        const pctHp = Math.floor((stats.heal_pct || 0) * c.max_hp);
        const pctMp = Math.floor((stats.restore_pct || 0) * c.max_mp);

        const totalHealHp = healHp + pctHp;
        const totalHealMp = healMp + pctMp;

        const newHp = Math.min(c.max_hp, c.current_hp + totalHealHp);
        const newMp = Math.min(c.max_mp, c.current_mp + totalHealMp);

        const actualHpHealed = newHp - c.current_hp;
        const actualMpHealed = newMp - c.current_mp;

        // Apply effects
        await db.query(
            'UPDATE characters SET current_hp=?, current_mp=? WHERE id=?',
            [newHp, newMp, charId]
        );

        // Consume item (remove 1 from quantity)
        if (item.quantity > 1) {
            await db.query('UPDATE character_items SET quantity=quantity-1 WHERE character_id=? AND item_id=?', [charId, itemId]);
        } else {
            await db.query('DELETE FROM character_items WHERE character_id=? AND item_id=?', [charId, itemId]);
        }

        // Build result message
        const parts = [];
        if (actualHpHealed > 0) parts.push(`+${actualHpHealed} HP`);
        if (actualMpHealed > 0) parts.push(`+${actualMpHealed} MP`);
        const message = parts.length ? `${item.icon || '🧪'} ${item.name}: ${parts.join(', ')}!` : `Used ${item.name}.`;

        res.json({
            success: true,
            message,
            newHp, newMp,
            hpRestored: actualHpHealed,
            mpRestored: actualMpHealed
        });
    } catch (e) {
        console.error('/use-item error:', e);
        res.json({ success: false, message: 'Server error.' });
    }
});

// --- GET ALL MAPS (for world map / fast travel) ---
// Returns all maps with id, name, description, fast_travel_enabled flag.
// Teaching: The client uses this to draw the World Map panel — a clickable
// grid of all maps in the game. We only return safe display data, not the
// full tile arrays (those are only needed when actually loading a map).
router.post('/get-all-maps', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, name, description, width, height,
                    COALESCE(fast_travel_enabled, 1) AS fast_travel_enabled,
                    COALESCE(min_level, 1) AS min_level
             FROM game_maps WHERE is_active IS NULL OR is_active=1
             ORDER BY id ASC`
        );
        res.json({ success: true, maps: rows });
    } catch (e) {
        // If fast_travel_enabled / min_level columns don't exist, retry without them
        try {
            const [rows] = await db.query('SELECT id, name, description, width, height FROM game_maps ORDER BY id ASC');
            res.json({ success: true, maps: rows.map(m => ({ ...m, fast_travel_enabled: 1, min_level: 1 })) });
        } catch (e2) {
            res.json({ success: false, message: 'Server error.' });
        }
    }
});

// --- FIND CHARACTER BY NAME (for friend requests) ---
// Teaching: The client needs to resolve a typed name → character ID
// before sending a friend request. We only return name + id (not
// sensitive stats) so it's safe to expose to any logged-in player.
router.post('/get-char-by-name', async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.json({ success: false, message: 'No name provided.' });
    try {
        const [rows] = await db.query(
            'SELECT id, name, level FROM characters WHERE LOWER(name)=LOWER(?) LIMIT 1',
            [name.trim()]
        );
        if (!rows.length) return res.json({ success: false, message: 'Character not found.' });
        res.json({ success: true, charId: rows[0].id, name: rows[0].name, level: rows[0].level });
    } catch (e) {
        res.json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
