const NpcManager = {
    init: async () => {
        document.getElementById('pageTitle').innerText = "NPC DATABASE";
        const res = await API.getAll('npc');
        NpcManager.render(res.success ? res.data : []);
    },

    render: (data) => {
        let html = `<button class="action-btn" onclick="NpcManager.edit()">+ NEW NPC</button>`;
        html += `<table><thead><tr><th>NAME</th><th>PERSONA PREVIEW</th><th>ACTIONS</th></tr></thead><tbody>`;
        
        data.forEach(n => {
            html += `<tr>
                <td><b>${n.name}</b></td>
                <td><small>${n.ai_persona ? n.ai_persona.substring(0, 50) + '...' : 'Default'}</small></td>
                <td>
                    <button class="edit-btn" onclick='NpcManager.edit(${JSON.stringify(n)})'>EDIT</button>
                    <button class="del-btn" onclick="NpcManager.del(${n.id})">DEL</button>
                </td>
            </tr>`;
        });
        document.getElementById('dynamicArea').innerHTML = html + "</tbody></table>";
    },

    edit: (npc = {}) => {
        const html = `
            <h3>Edit NPC</h3>
            <label>Name</label><input id="n_name" value="${npc.name || ''}">
            <label>AI Persona (Who are they?)</label>
            <textarea id="n_persona" rows="5" placeholder="You are a grumpy blacksmith...">${npc.ai_persona || ''}</textarea>
            <label>Stats (HP/Str)</label>
            <input id="n_stats" value='${npc.stats_json ? JSON.stringify(npc.stats_json) : '{"hp":100}'}'>
            
            <button class="action-btn" onclick="NpcManager.save(${npc.id || null})">SAVE NPC</button>
            <button class="edit-btn" onclick="NpcManager.init()">CANCEL</button>
        `;
        document.getElementById('dynamicArea').innerHTML = html;
    },

    save: async (id) => {
        await API.save('npc', {
            name: document.getElementById('n_name').value,
            ai_persona: document.getElementById('n_persona').value,
            stats_json: document.getElementById('n_stats').value
        }, id);
        NpcManager.init();
    },

    del: async (id) => { if(confirm("Delete?")) { await API.delete('npc', id); NpcManager.init(); } }
};