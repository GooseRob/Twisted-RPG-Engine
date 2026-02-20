// =================================================================
// SETTINGS MANAGER — System Configuration & Label Editor
// =================================================================
const SettingsManager = {
    data: {},

    init: async () => {
        document.getElementById('pageTitle').innerText = "⚙️ SYSTEM SETTINGS";
        document.getElementById('dynamicArea').innerHTML = '<p>Loading...</p>';
        const r = await API.post('/admin/get-settings');
        if (r.success) { SettingsManager.data = r.data; SettingsManager.render(); }
        else { document.getElementById('dynamicArea').innerHTML = '<p>Error loading settings.</p>'; }
    },

    render: () => {
        const d = SettingsManager.data;
        const keys = Object.keys(d).sort();

        // Group settings by prefix
        const groups = {};
        keys.forEach(k => {
            const prefix = k.includes('_') ? k.split('_')[0] : 'general';
            if (!groups[prefix]) groups[prefix] = [];
            groups[prefix].push(k);
        });

        let h = `
        <p style="color:var(--td);font-size:12px;margin-bottom:16px">Edit game settings, labels, and feature toggles. Changes take effect on next page load or server restart.</p>
        <div style="display:flex;gap:8px;margin-bottom:16px">
            <button class="action-btn" onclick="SettingsManager.addSetting()">+ ADD SETTING</button>
        </div>`;

        for (const [group, settingKeys] of Object.entries(groups)) {
            h += `<div style="margin-bottom:20px">
                <h3 style="color:var(--a);font-size:14px;text-transform:uppercase;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--b)">${group}</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`;

            for (const key of settingKeys) {
                const val = d[key];
                const isBool = val === 'true' || val === 'false';
                const isNum = !isBool && !isNaN(val) && val !== '';

                h += `<div style="background:var(--bg2);border:1px solid var(--b);border-radius:6px;padding:12px;display:flex;align-items:center;gap:10px">
                    <div style="flex:1">
                        <div style="font-size:12px;color:var(--td);font-family:monospace">${key}</div>`;

                if (isBool) {
                    h += `<select onchange="SettingsManager.saveSetting('${key}',this.value)" style="margin-top:4px;width:auto;padding:4px 8px">
                        <option value="true" ${val==='true'?'selected':''}>✅ Enabled</option>
                        <option value="false" ${val==='false'?'selected':''}>❌ Disabled</option>
                    </select>`;
                } else if (isNum) {
                    h += `<input type="number" value="${val}" onchange="SettingsManager.saveSetting('${key}',this.value)" style="margin-top:4px;width:100px;padding:4px 8px">`;
                } else {
                    h += `<input value="${SettingsManager._esc(val)}" onchange="SettingsManager.saveSetting('${key}',this.value)" style="margin-top:4px;padding:4px 8px">`;
                }

                h += `</div>
                    <button class="del-btn" style="padding:4px 8px" onclick="SettingsManager.delSetting('${key}')" title="Delete">✕</button>
                </div>`;
            }
            h += '</div></div>';
        }

        // Quick-add label overrides section
        h += `
        <div style="margin-top:24px;background:var(--bg2);border:1px solid var(--b);border-radius:8px;padding:16px">
            <h3 style="color:var(--y);font-size:14px;margin-bottom:8px">🏷️ LABEL OVERRIDES</h3>
            <p style="color:var(--td);font-size:12px;margin-bottom:12px">Rename anything in the game. The server and client will use these labels. Want "Limit Break" to say "Overdrive"? Change it here.</p>
            <div class="grid-2">
                ${SettingsManager._labelBtn('label_limitbreak', 'Limit Break Label', d.label_limitbreak || 'Limit Break')}
                ${SettingsManager._labelBtn('label_skills_menu', 'Skills Menu Label', d.label_skills_menu || 'Skills')}
                ${SettingsManager._labelBtn('label_attack', 'Attack Label', d.label_attack || 'Attack')}
                ${SettingsManager._labelBtn('label_defend', 'Defend Label', d.label_defend || 'Defend')}
                ${SettingsManager._labelBtn('label_currency', 'Currency Name', d.label_currency || 'Gold')}
                ${SettingsManager._labelBtn('label_experience', 'Experience Label', d.label_experience || 'XP')}
            </div>
        </div>`;

        document.getElementById('dynamicArea').innerHTML = h;
    },

    _labelBtn: (key, label, val) => {
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
            <span style="color:var(--td);font-size:12px;min-width:140px">${label}:</span>
            <input value="${SettingsManager._esc(val)}" onchange="SettingsManager.saveSetting('${key}',this.value)" style="padding:4px 8px;flex:1">
        </div>`;
    },

    saveSetting: async (key, value) => {
        const r = await API.post('/admin/save-setting', { key, value });
        if (r.success) {
            SettingsManager.data[key] = value;
            // Flash feedback
            const el = event?.target;
            if (el) { el.style.borderColor = 'var(--g)'; setTimeout(() => el.style.borderColor = '', 1000); }
        }
    },

    addSetting: () => {
        const key = prompt('Setting key (e.g. label_attack):');
        if (!key) return;
        const val = prompt('Value:', 'true');
        if (val === null) return;
        SettingsManager.saveSetting(key, val).then(() => SettingsManager.init());
    },

    delSetting: async (key) => {
        if (!confirm(`Delete setting "${key}"?`)) return;
        try {
            const r = await API.post('/admin/delete-setting', { key });
            if (r.success) { delete SettingsManager.data[key]; SettingsManager.render(); }
        } catch { alert('Delete failed.'); }
    },

    _esc: (s) => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')
};
