// =================================================================
// GUILD ROUTES — Persistent guild management REST API
// =================================================================
// Mounted at /api/guild
//
// Real-time guild events (invite, accept, chat) happen via Socket.IO
// in server.js. These REST routes handle persistence: CRUD for guilds,
// member lists, invite history, and guild search.
//
// Socket events (in server.js):
//   guild_invite  { targetCharId } — invite a player
//   guild_accept  { guildId }      — accept invite
//   guild_decline { guildId }      — decline invite
//   guild_leave   {}               — leave guild
//   guild_kick    { targetCharId } — kick (leader/officer only)
//   guild_promote { targetCharId } — promote to officer
//   guild_demote  { targetCharId } — demote to member
//
// REST endpoints here:
//   GET  /api/guild/my/:charId/:userId          — get my guild + members
//   GET  /api/guild/search?q=name               — search guilds by name/tag
//   GET  /api/guild/info/:guildId               — get guild info + members
//   POST /api/guild/create                      — create a new guild
//   POST /api/guild/disband                     — disband (leader only)
// =================================================================

const express = require('express');
const router  = express.Router();
let db;
router.init = (d) => { db = d; return router; };

// ── HELPERS ──────────────────────────────────────────────────────
async function verifyChar(userId, charId) {
    const [r] = await db.query(
        'SELECT id, name FROM characters WHERE id=? AND user_id=?', [charId, userId]
    );
    return r.length ? r[0] : null;
}

async function getMyGuild(charId) {
    const [rows] = await db.query(
        `SELECT gm.rank, gm.joined_at, g.*
         FROM guild_members gm
         JOIN guilds g ON g.id = gm.guild_id
         WHERE gm.character_id = ? AND gm.is_active = 1 AND g.is_active = 1
         LIMIT 1`,
        [charId]
    );
    return rows.length ? rows[0] : null;
}

async function getGuildMembers(guildId) {
    const [rows] = await db.query(
        `SELECT gm.rank, gm.joined_at, c.id AS char_id, c.name, c.level,
                cl.name AS class_name
         FROM guild_members gm
         JOIN characters c ON c.id = gm.character_id
         LEFT JOIN game_classes cl ON cl.id = c.class_id
         WHERE gm.guild_id = ? AND gm.is_active = 1
         ORDER BY FIELD(gm.rank,'LEADER','OFFICER','MEMBER'), c.level DESC`,
        [guildId]
    );
    return rows;
}

// ── GET MY GUILD ──────────────────────────────────────────────────
router.get('/my/:charId/:userId', async (req, res) => {
    try {
        const { charId, userId } = req.params;
        if (!await verifyChar(userId, charId)) return res.json({ success: false, error: 'Unauthorized' });

        const guild = await getMyGuild(charId);
        if (!guild) return res.json({ success: true, data: null });

        const members = await getGuildMembers(guild.id);
        // Pending invites I received
        const [invites] = await db.query(
            `SELECT gi.*, g.name AS guild_name, g.tag, g.emblem, c.name AS inviter_name
             FROM guild_invites gi
             JOIN guilds g ON g.id = gi.guild_id
             JOIN characters c ON c.id = gi.inviter_id
             WHERE gi.invitee_id = ? AND gi.status = 'pending' AND gi.expires_at > NOW()`,
            [charId]
        );

        res.json({ success: true, data: { guild, members, pendingInvites: invites } });
    } catch (e) {
        console.error('guild/my error:', e);
        res.json({ success: false, error: e.message });
    }
});

// ── SEARCH GUILDS ─────────────────────────────────────────────────
router.get('/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        let rows;
        if (q) {
            [rows] = await db.query(
                `SELECT g.*, COUNT(gm.id) AS member_count
                 FROM guilds g
                 LEFT JOIN guild_members gm ON gm.guild_id = g.id AND gm.is_active = 1
                 WHERE g.is_active = 1 AND (g.name LIKE ? OR g.tag LIKE ?)
                 GROUP BY g.id ORDER BY member_count DESC LIMIT 20`,
                [`%${q}%`, `%${q}%`]
            );
        } else {
            [rows] = await db.query(
                `SELECT g.*, COUNT(gm.id) AS member_count
                 FROM guilds g
                 LEFT JOIN guild_members gm ON gm.guild_id = g.id AND gm.is_active = 1
                 WHERE g.is_active = 1
                 GROUP BY g.id ORDER BY member_count DESC LIMIT 20`
            );
        }
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ── GET GUILD INFO ────────────────────────────────────────────────
router.get('/info/:guildId', async (req, res) => {
    try {
        const [guild] = await db.query('SELECT * FROM guilds WHERE id=? AND is_active=1', [req.params.guildId]);
        if (!guild.length) return res.json({ success: false, error: 'Guild not found' });
        const members = await getGuildMembers(guild[0].id);
        res.json({ success: true, data: { guild: guild[0], members } });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ── CREATE GUILD ──────────────────────────────────────────────────
router.post('/create', async (req, res) => {
    try {
        const { userId, charId, name, tag, description, emblem } = req.body;
        const char = await verifyChar(userId, charId);
        if (!char) return res.json({ success: false, error: 'Unauthorized' });

        // Must not already be in a guild
        const existing = await getMyGuild(charId);
        if (existing) return res.json({ success: false, error: 'Already in a guild. Leave first.' });

        // Validate
        const gName = (name || '').trim();
        const gTag  = (tag  || '').trim().toUpperCase().slice(0, 6);
        if (!gName || gName.length < 2 || gName.length > 64) return res.json({ success: false, error: 'Name must be 2-64 chars' });
        if (!gTag  || gTag.length  < 2 || gTag.length  > 6)  return res.json({ success: false, error: 'Tag must be 2-6 chars' });

        // Check name uniqueness
        const [taken] = await db.query('SELECT id FROM guilds WHERE name=?', [gName]);
        if (taken.length) return res.json({ success: false, error: 'Guild name already taken' });

        const [result] = await db.query(
            'INSERT INTO guilds (name, tag, leader_id, description, emblem) VALUES (?,?,?,?,?)',
            [gName, gTag, charId, description || '', emblem || '⚔️']
        );
        const guildId = result.insertId;
        await db.query(
            "INSERT INTO guild_members (guild_id, character_id, rank) VALUES (?,?,'LEADER')",
            [guildId, charId]
        );

        res.json({ success: true, guildId, guildName: gName, guildTag: gTag });
    } catch (e) {
        console.error('guild/create error:', e);
        res.json({ success: false, error: e.message });
    }
});

// ── DISBAND GUILD ─────────────────────────────────────────────────
router.post('/disband', async (req, res) => {
    try {
        const { userId, charId, guildId } = req.body;
        if (!await verifyChar(userId, charId)) return res.json({ success: false, error: 'Unauthorized' });

        const [g] = await db.query('SELECT * FROM guilds WHERE id=? AND leader_id=? AND is_active=1', [guildId, charId]);
        if (!g.length) return res.json({ success: false, error: 'Not guild leader' });

        await db.query('UPDATE guilds SET is_active=0, disbanded_at=NOW() WHERE id=?', [guildId]);
        await db.query('UPDATE guild_members SET is_active=0, left_at=NOW() WHERE guild_id=?', [guildId]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

module.exports = router;
