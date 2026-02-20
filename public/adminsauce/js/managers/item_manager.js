const ItemManager = {
    init: async () => {
        document.getElementById('pageTitle').innerText = "ITEM DATABASE";
        const res = await API.getAll('item');
        ItemManager.render(res.success ? res.data : []);
    },

    render: (data) => {
        let html = `<button class="action-btn" onclick="ItemManager.edit()">+ NEW ITEM</button>`;
        html += `<table><thead><tr><th>ICON</th><th>NAME</th><th>TYPE</th><th>VALUE</th><th>ACTIONS</th></tr></thead><tbody>`;
        
        data.forEach(i => {
            html += `<tr>
                <td style="font-size:20px">${i.icon || '📦'}</td>
                <td><b>${i.name}</b></td>
                <td>${i.type}</td>
                <td>${i.value}g</td>
                <td>
                    <button class="edit-btn" onclick='ItemManager.edit(${JSON.stringify(i)})'>EDIT</button>
                    <button class="del-btn" onclick="ItemManager.del(${i.id})">DEL</button>
                </td>
            </tr>`;
        });
        document.getElementById('dynamicArea').innerHTML = html + "</tbody></table>";
    },

    edit: (item = {}) => {
        const isNew = !item.id;
        const html = `
            <h3>${isNew ? 'Create Item' : 'Edit Item'}</h3>
            <label>Name</label><input id="i_name" value="${item.name || ''}">
            <div style="display:flex; gap:10px;">
                <div style="flex:1"><label>Type</label>
                    <select id="i_type">
                        <option ${item.type==='WEAPON'?'selected':''}>WEAPON</option>
                        <option ${item.type==='ARMOR'?'selected':''}>ARMOR</option>
                        <option ${item.type==='CONSUMABLE'?'selected':''}>CONSUMABLE</option>
                        <option ${item.type==='MISC'?'selected':''}>MISC</option>
                    </select>
                </div>
                <div style="flex:1"><label>Icon (Emoji)</label><input id="i_icon" value="${item.icon || '📦'}"></div>
                <div style="flex:1"><label>Value (Gold)</label><input id="i_value" type="number" value="${item.value || 0}"></div>
            </div>
            <label>Stats (JSON)</label><textarea id="i_stats" rows="3">${item.stats_json ? JSON.stringify(item.stats_json) : '{}'}</textarea>
            <button class="action-btn" onclick="ItemManager.save(${item.id || null})">SAVE ITEM</button>
            <button class="edit-btn" onclick="ItemManager.init()">CANCEL</button>
        `;
        document.getElementById('dynamicArea').innerHTML = html;
    },

    save: async (id) => {
        const payload = {
            name: document.getElementById('i_name').value,
            type: document.getElementById('i_type').value,
            icon: document.getElementById('i_icon').value,
            value: document.getElementById('i_value').value,
            stats_json: document.getElementById('i_stats').value
        };
        await API.save('item', payload, id);
        ItemManager.init();
    },

    del: async (id) => { if(confirm("Delete?")) { await API.delete('item', id); ItemManager.init(); } }
};