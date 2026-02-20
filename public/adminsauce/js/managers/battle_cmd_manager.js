// =================================================================
// BATTLE COMMAND MANAGER — Edit Attack, Defend, Skills menu, etc.
// =================================================================
const BattleCmdManager = {
    data: [],

    init: async () => {
        document.getElementById('pageTitle').innerText = "⚔️ BATTLE COMMANDS";
        document.getElementById('dynamicArea').innerHTML = '<p>Loading...</p>';
        const r = await API.getAll('battle_cmd');
        if (r.success) { BattleCmdManager.data = r.data; BattleCmdManager.renderList(); }
    },

    renderList: () => {
        const d = BattleCmdManager.data;
        let h = `<button class="action-btn save-btn" onclick="BattleCmdManager.edit()">+ NEW COMMAND</button>
        <p style="color:var(--td);font-size:12px;margin:8px 0">These are the top-level menu choices in combat. All classes get "default" commands. Add class-specific ones via the class editor's <code>battle_cmds</code> field.</p>
        <table><thead><tr><th>ORDER</th><th>ICON</th><th>NAME</th><th>TARGET</th><th>DEFAULT?</th><th>EFFECT PREVIEW</th><th>ACTIONS</th></tr></thead><tbody>`;
        d.sort((a,b) => a.display_order - b.display_order).forEach(c => {
            const fx = BattleCmdManager._fxPreview(c.effects);
            h += `<tr>
                <td>${c.display_order}</td>
                <td style="font-size:20px">${c.icon||'⚔️'}</td>
                <td><b>${c.name}</b><br><small style="color:var(--td)">${c.description||''}</small></td>
                <td><span class="tag tag-purple">${c.target_type}</span></td>
                <td>${c.is_default ? '<span class="tag tag-green">YES</span>' : '<span class="tag tag-yellow">CLASS</span>'}</td>
                <td><code style="font-size:11px">${fx}</code></td>
                <td>
                    <button class="edit-btn" onclick="BattleCmdManager.edit(${c.id})">EDIT</button>
                    <button class="del-btn" onclick="BattleCmdManager.del(${c.id})">DEL</button>
                </td>
            </tr>`;
        });
        h += '</tbody></table>';
        document.getElementById('dynamicArea').innerHTML = h;
    },

    edit: (id) => {
        const item = id ? BattleCmdManager.data.find(c => c.id === id) : {};
        const d = item || {};
        let effects = '{}';
        try { effects = typeof d.effects === 'string' ? d.effects : JSON.stringify(d.effects || {}, null, 2); } catch { effects = '{}'; }

        document.getElementById('dynamicArea').innerHTML = `
        <h3>${id ? 'Edit Command: ' + d.name : 'New Battle Command'}</h3>
        <div class="grid-2">
            <div><label>NAME</label><input id="c_name" value="${d.name || ''}"></div>
            <div><label>ICON (Emoji)</label><input id="c_icon" value="${d.icon || '⚔️'}"></div>
        </div>
        <label>DESCRIPTION</label><input id="c_desc" value="${d.description || ''}">
        <div class="grid-3">
            <div><label>TARGET TYPE</label>
                <select id="c_target">
                    ${['SELF','ENEMY','SELF_OR_ENEMY','ALL','MENU','NONE'].map(t => 
                        `<option ${d.target_type===t?'selected':''}>${t}</option>`).join('')}
                </select>
            </div>
            <div><label>DISPLAY ORDER</label><input id="c_order" type="number" value="${d.display_order || 0}"></div>
            <div><label>DEFAULT (All Classes)?</label>
                <select id="c_default"><option value="1" ${d.is_default?'selected':''}>Yes</option><option value="0" ${!d.is_default?'selected':''}>No (Class-specific)</option></select>
            </div>
        </div>
        <label>EFFECTS (JSON) — <span style="color:var(--td)">This defines what the command does. See examples below.</span></label>
        <textarea id="c_effects" rows="8" style="font-family:Consolas,monospace">${effects}</textarea>
        <div style="background:var(--bg2);border:1px solid var(--b);border-radius:8px;padding:12px;margin-bottom:12px;font-size:11px;color:var(--td)">
            <b style="color:var(--a)">Effect Templates:</b><br>
            <b>Attack:</b> <code>{"damage":{"formula":"ATK*2-DEF","randomize":0.125},"apply_weapon_status":true,"apply_weapon_elements":true,"log":"{name} attacks!"}</code><br>
            <b>Defend:</b> <code>{"set_status":{"target":"self","statuses":{"defending":1}},"log":"{name} defends."}</code><br>
            <b>Flee:</b> <code>{"flee":{"formula":"SPEED+LUCK*0.5>ENEMY_SPEED","log_success":"{name} escapes!","log_fail":"{name} couldn't escape!"}}</code><br>
            <b>Submenu:</b> <code>{"open_menu":"skills"}</code> or <code>{"open_menu":"items"}</code><br>
            <b>Variables:</b> ATK, DEF, MO, MD, SPEED, LUCK, MAXHP, MAXMP, LVL, ENEMY_ATK, ENEMY_DEF, ENEMY_SPEED, ENEMY_LVL
        </div>
        <div class="btn-row">
            <button class="action-btn save-btn" onclick="BattleCmdManager.save(${id||'null'})">💾 SAVE</button>
            <button class="edit-btn" onclick="BattleCmdManager.init()">CANCEL</button>
        </div>`;
    },

    save: async (id) => {
        let effects = document.getElementById('c_effects').value;
        try { effects = JSON.stringify(JSON.parse(effects)); } catch { alert('Invalid JSON in effects!'); return; }
        const payload = {
            name: document.getElementById('c_name').value,
            description: document.getElementById('c_desc').value,
            icon: document.getElementById('c_icon').value,
            target_type: document.getElementById('c_target').value,
            display_order: parseInt(document.getElementById('c_order').value) || 0,
            is_default: parseInt(document.getElementById('c_default').value),
            effects: effects
        };
        const r = await API.save('battle_cmd', payload, id);
        if (r.success) BattleCmdManager.init(); else alert(r.message);
    },

    del: async (id) => { if (confirm('Delete command?')) { await API.delete('battle_cmd', id); BattleCmdManager.init(); } },

    _fxPreview: (fx) => {
        try {
            const e = typeof fx === 'string' ? JSON.parse(fx) : fx;
            if (e.damage) return 'DMG: ' + (e.damage.formula || '?');
            if (e.flee) return 'FLEE';
            if (e.open_menu) return 'MENU: ' + e.open_menu;
            if (e.set_status) return 'STATUS';
            return Object.keys(e).join(', ');
        } catch { return '?'; }
    }
};
