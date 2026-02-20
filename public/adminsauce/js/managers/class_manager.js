// =================================================================
// CLASS MANAGER (The Specialist)
// =================================================================
// Handles displaying, editing, and saving Character Classes.

const ClassManager = {
    // A. CONFIGURATION
    // What database columns do we care about?
    config: {
        type: 'class',
        tableColumns: ['name', 'base_hp', 'base_str', 'base_int'], // Shown in list
        formFields: ['name', 'base_hp', 'base_mp', 'base_str', 'base_int', 'base_speed'] // Shown in editor
    },

    // B. INITIALIZE (Load the list)
    init: async () => {
        document.getElementById('pageTitle').innerText = "CLASS MANAGER";
        document.getElementById('dynamicArea').innerHTML = "Loading Classes...";

        // 1. Get Data
        const response = await API.getAll('class');
        if (!response.success) return alert("Failed to load classes");

        // 2. Draw Table
        ClassManager.renderTable(response.data);
    },

    // C. RENDER TABLE (The List View)
    renderTable: (data) => {
        let html = `<button class="action-btn save-btn" onclick="ClassManager.edit(null)">+ CREATE NEW CLASS</button>`;
        html += `<table><thead><tr><th>NAME</th><th>HP</th><th>STR</th><th>ACTIONS</th></tr></thead><tbody>`;

        data.forEach(item => {
            html += `<tr>
                <td><b>${item.name}</b></td>
                <td>${item.base_hp}</td>
                <td>${item.base_str}</td>
                <td>
                    <button class="edit-btn" onclick='ClassManager.edit(${JSON.stringify(item)})'>EDIT</button>
                    <button class="del-btn" onclick="ClassManager.delete(${item.id})">DEL</button>
                </td>
            </tr>`;
        });
        html += `</tbody></table>`;
        document.getElementById('dynamicArea').innerHTML = html;
    },

    // D. RENDER FORM (The Editor)
    edit: (item) => {
        const isNew = !item;
        const data = item || {}; // If null, use empty object

        let html = `<div class="editor-box visible">
            <h3>${isNew ? "Create New Class" : "Edit Class: " + data.name}</h3>
            <input type="hidden" id="editId" value="${data.id || ''}">`;

        // 1. Loop through our config fields to create inputs automatically
        ClassManager.config.formFields.forEach(field => {
            const val = data[field] || ''; // Existing value or empty
            const label = field.toUpperCase().replace('BASE_', '');
            
            html += `<label>${label}</label>
                     <input type="text" id="in_${field}" value="${val}">`;
        });

        // 2. Add Buttons
        html += `<div style="display:flex; gap:10px; margin-top:10px;">
                    <button class="action-btn save-btn" onclick="ClassManager.save()">SAVE</button>
                    <button class="action-btn" onclick="ClassManager.init()">CANCEL</button>
                 </div></div>`;

        document.getElementById('dynamicArea').innerHTML = html;
    },

    // E. SAVE LOGIC
    save: async () => {
        const id = document.getElementById('editId').value;
        const payload = {};

        // Gather data dynamically
        ClassManager.config.formFields.forEach(field => {
            payload[field] = document.getElementById(`in_${field}`).value;
        });

        const res = await API.save('class', payload, id);
        if (res.success) {
            alert("Class Saved!");
            ClassManager.init(); // Reload list
        } else {
            alert("Error: " + res.message);
        }
    },

    // F. DELETE LOGIC
    delete: async (id) => {
        const res = await API.delete('class', id);
        if (res.success) ClassManager.init();
    }
};