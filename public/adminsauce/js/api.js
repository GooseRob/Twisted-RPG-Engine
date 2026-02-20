const API = {
    userId: () => localStorage.getItem('twisted_id'),
    getAll: async (type) => {
        try {
            const r = await fetch('/admin/get-all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,userId:API.userId()})});
            if(r.status===403){alert('Access denied.');return{success:false};}
            return await r.json();
        } catch(e) { return {success:false,message:"Connection failed."}; }
    },
    save: async (type, data, id=null) => {
        try {
            const r = await fetch('/admin/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,data,id,userId:API.userId()})});
            if(r.status===403){alert('Access denied.');return{success:false};}
            return await r.json();
        } catch(e) { return {success:false,message:"Save failed."}; }
    },
    delete: async (type, id) => {
        try {
            const r = await fetch('/admin/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,id,userId:API.userId()})});
            return await r.json();
        } catch(e) { return {success:false}; }
    },
    clearCache: async (mapId) => fetch('/admin/clear-cache',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mapId,userId:API.userId()})}).then(r=>r.json()).catch(()=>({})),
    post: async (url, data={}) => {
        try {
            const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,userId:API.userId()})});
            if(r.status===403){alert('Access denied.');return{success:false};}
            return await r.json();
        } catch(e) { return {success:false,message:"Request failed."}; }
    }
};
