// =================================================================
// SHOP SUPPLY MANAGER — What each shop sells
// =================================================================
const ShopSupplyManager = {
    shops: [],
    items: [],
    data: [],
    selectedShop: null,

    init: async () => {
        document.getElementById('pageTitle').innerText = "🏪 SHOP INVENTORY";
        document.getElementById('dynamicArea').innerHTML = '<p>Loading...</p>';
        const [shops, items, supplies] = await Promise.all([
            API.getAll('shop'), API.getAll('item'), API.getAll('shop_supply')
        ]);
        ShopSupplyManager.shops = shops.success ? shops.data : [];
        ShopSupplyManager.items = items.success ? items.data : [];
        ShopSupplyManager.data = supplies.success ? supplies.data : [];
        ShopSupplyManager.renderShopPicker();
    },

    renderShopPicker: () => {
        const shops = ShopSupplyManager.shops;
        let h = `<p style="color:var(--td);font-size:12px;margin-bottom:12px">Select a shop to manage its inventory, prices, and stock.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px">`;
        shops.forEach(s => {
            const supplyCount = ShopSupplyManager.data.filter(d => d.shop_id === s.id).length;
            h += `<div onclick="ShopSupplyManager.selectShop(${s.id})" style="background:var(--bg2);border:1px solid var(--b);border-radius:8px;padding:16px;cursor:pointer;transition:.15s"
                onmouseover="this.style.borderColor='var(--a)'" onmouseout="this.style.borderColor='var(--b)'">
                <div style="font-size:16px;color:var(--a);font-weight:bold">🏪 ${s.name}</div>
                <div style="font-size:12px;color:var(--td);margin-top:4px">${s.description||'No description'}</div>
                <div style="font-size:11px;color:var(--td);margin-top:8px">${supplyCount} items · ${s.shop_type||'GENERAL'}</div>
            </div>`;
        });
        h += `<div onclick="ShopSupplyManager.createShop()" style="background:var(--bg3);border:2px dashed var(--b);border-radius:8px;padding:16px;cursor:pointer;text-align:center;display:flex;align-items:center;justify-content:center;color:var(--td)"
            onmouseover="this.style.borderColor='var(--g)'" onmouseout="this.style.borderColor='var(--b)'">
            <span style="font-size:24px">+</span>&nbsp;NEW SHOP
        </div>`;
        h += '</div>';
        document.getElementById('dynamicArea').innerHTML = h;
    },

    createShop: async () => {
        const name = prompt('Shop Name:');
        if (!name) return;
        await API.save('shop', { name, description: '', shop_type: 'GENERAL' });
        ShopSupplyManager.init();
    },

    selectShop: (shopId) => {
        ShopSupplyManager.selectedShop = shopId;
        ShopSupplyManager.renderSupplies();
    },

    renderSupplies: () => {
        const shopId = ShopSupplyManager.selectedShop;
        const shop = ShopSupplyManager.shops.find(s => s.id === shopId);
        const supplies = ShopSupplyManager.data.filter(d => d.shop_id === shopId);

        const itemOpts = ShopSupplyManager.items.map(i => `<option value="${i.id}">${i.icon||'📦'} ${i.name} (${i.type})</option>`).join('');

        let h = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="margin:0;color:var(--a)">${shop ? shop.name : 'Shop'} — Inventory</h3>
            <div style="display:flex;gap:8px">
                <button class="edit-btn" onclick="ShopSupplyManager.editShop(${shopId})">✏️ Edit Shop</button>
                <button class="del-btn" onclick="ShopSupplyManager.deleteShop(${shopId})">🗑️ Delete Shop</button>
                <button class="edit-btn" onclick="ShopSupplyManager.init()">← Back</button>
            </div>
        </div>

        <div style="background:var(--bg2);border:1px solid var(--b);border-radius:8px;padding:12px;margin-bottom:16px">
            <div style="display:flex;gap:8px;align-items:end">
                <div style="flex:2"><label>ADD ITEM</label><select id="ss_item">${itemOpts}</select></div>
                <div style="flex:1"><label>BUY PRICE</label><input id="ss_buy" type="number" value="100"></div>
                <div style="flex:1"><label>SELL PRICE</label><input id="ss_sell" type="number" value="25"></div>
                <div style="flex:1"><label>STOCK (-1=∞)</label><input id="ss_stock" type="number" value="-1"></div>
                <button class="action-btn save-btn" onclick="ShopSupplyManager.addItem(${shopId})">+ ADD</button>
            </div>
        </div>

        <table><thead><tr><th>ICON</th><th>ITEM</th><th>TYPE</th><th>BUY</th><th>SELL</th><th>STOCK</th><th>ACTIONS</th></tr></thead><tbody>`;

        supplies.forEach(s => {
            const item = ShopSupplyManager.items.find(i => i.id === s.item_id);
            h += `<tr>
                <td style="font-size:20px">${item?item.icon:'?'}</td>
                <td><b>${item?item.name:'#'+s.item_id}</b></td>
                <td>${item?item.type:'?'}</td>
                <td><input type="number" value="${s.buy_price}" style="width:70px;padding:4px" onchange="ShopSupplyManager.updatePrice(${s.id},'buy_price',this.value)"></td>
                <td><input type="number" value="${s.sell_price||0}" style="width:70px;padding:4px" onchange="ShopSupplyManager.updatePrice(${s.id},'sell_price',this.value)"></td>
                <td>${s.stock < 0 ? '∞' : s.stock}</td>
                <td><button class="del-btn" onclick="ShopSupplyManager.removeItem(${s.id})">✕</button></td>
            </tr>`;
        });
        h += '</tbody></table>';
        document.getElementById('dynamicArea').innerHTML = h;
    },

    addItem: async (shopId) => {
        const payload = {
            shop_id: shopId,
            item_id: parseInt(document.getElementById('ss_item').value),
            buy_price: parseInt(document.getElementById('ss_buy').value),
            sell_price: parseInt(document.getElementById('ss_sell').value),
            stock: parseInt(document.getElementById('ss_stock').value)
        };
        await API.save('shop_supply', payload);
        // Reload
        const r = await API.getAll('shop_supply');
        if (r.success) ShopSupplyManager.data = r.data;
        ShopSupplyManager.renderSupplies();
    },

    updatePrice: async (id, field, val) => {
        await API.save('shop_supply', { [field]: parseInt(val) }, id);
    },

    removeItem: async (id) => {
        await API.delete('shop_supply', id);
        const r = await API.getAll('shop_supply');
        if (r.success) ShopSupplyManager.data = r.data;
        ShopSupplyManager.renderSupplies();
    },

    editShop: (shopId) => {
        const shop = ShopSupplyManager.shops.find(s => s.id === shopId) || {};
        document.getElementById('dynamicArea').innerHTML = `
        <h3>Edit Shop</h3>
        <div class="grid-2">
            <div><label>NAME</label><input id="es_name" value="${shop.name||''}"></div>
            <div><label>TYPE</label><select id="es_type">
                ${['GENERAL','WEAPON','ARMOR','MAGIC','INN','BLACK_MARKET'].map(t => `<option ${shop.shop_type===t?'selected':''}>${t}</option>`).join('')}
            </select></div>
        </div>
        <label>DESCRIPTION</label><textarea id="es_desc" rows="2">${shop.description||''}</textarea>
        <div class="grid-2">
            <div><label>NPC ID (shopkeeper)</label><input id="es_npc" type="number" value="${shop.npc_id||0}"></div>
            <div><label>MAP ID (location)</label><input id="es_map" type="number" value="${shop.location_map_id||0}"></div>
        </div>
        <div class="btn-row">
            <button class="action-btn save-btn" onclick="ShopSupplyManager.saveShop(${shopId})">💾 SAVE</button>
            <button class="edit-btn" onclick="ShopSupplyManager.selectShop(${shopId})">CANCEL</button>
        </div>`;
    },

    saveShop: async (id) => {
        await API.save('shop', {
            name: document.getElementById('es_name').value,
            description: document.getElementById('es_desc').value,
            shop_type: document.getElementById('es_type').value,
            npc_id: parseInt(document.getElementById('es_npc').value) || null,
            location_map_id: parseInt(document.getElementById('es_map').value) || null
        }, id);
        ShopSupplyManager.init();
    },

    deleteShop: async (id) => {
        if (confirm('Delete this shop and all its inventory?')) {
            await API.delete('shop', id);
            ShopSupplyManager.init();
        }
    }
};
