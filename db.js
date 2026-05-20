require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey && supabaseUrl !== 'tu_supabase_url_aqui') {
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.warn("⚠️ Advertencia: Credenciales de Supabase no configuradas en .env");
}

// ---------------------------------------------------------
// FUNCIONES DE USUARIO
// ---------------------------------------------------------
async function getUser(phoneNumber) {
    if (!supabase) return null;
    
    // Normalizar a los dos posibles formatos mexicanos (con y sin el '1' móvil)
    let clean = phoneNumber.replace(/\+/g, '').trim();
    let queryNumbers = [clean];
    
    if (clean.startsWith('521') && clean.length === 13) {
        const withoutOne = '52' + clean.substring(3);
        queryNumbers.push(withoutOne);
    } else if (clean.startsWith('52') && clean.length === 12) {
        const withOne = '521' + clean.substring(2);
        queryNumbers.push(withOne);
    }

    let { data, error } = await supabase.from('users').select('*').in('phone_number', queryNumbers).limit(1).maybeSingle();
    
    if (error) {
        console.error("Error fetching user:", error);
        return null;
    }

    if (!data) {
        const newUser = { phone_number: phoneNumber, language: null, current_state: null, step: 'idle' };
        const { data: inserted, error: insErr } = await supabase.from('users').insert([newUser]).select().single();
        if (insErr) { console.error("Error creating user:", insErr); return null; }
        return inserted;
    }

    // Si el formato en la base de datos es diferente al recibido en el webhook, 
    // lo actualizamos para que coincidan en futuras consultas directas
    if (data.phone_number !== phoneNumber) {
        console.log(`🔄 Actualizando número del cliente en DB de ${data.phone_number} a ${phoneNumber} para consistencia.`);
        await supabase.from('users').update({ phone_number: phoneNumber }).eq('phone_number', data.phone_number);
        data.phone_number = phoneNumber;
    }

    return data;
}

async function updateUser(phoneNumber, updates) {
    if (!supabase) return false;
    const { data, error } = await supabase.from('users').update(updates).eq('phone_number', phoneNumber).select();
    
    if (error) { 
        console.error("❌ [DB ERROR] Error updating user:", error); 
        return false; 
    }
    if (!data || data.length === 0) {
        console.error(`❌ [DB ERROR] updateUser falló silenciosamente: No se encontró el usuario ${phoneNumber} en la tabla 'users'.`);
        return false;
    }
    
    console.log(`✅ [DB] Usuario ${phoneNumber} actualizado a step: ${updates.step || 'sin_cambio'}`);
    return true;
}

// ---------------------------------------------------------
// FUNCIONES DE INVENTARIO Y BÚSQUEDA
// ---------------------------------------------------------
async function searchParts(queryText, state) {
    if (!supabase) return [];
    
    // Buscar la refacción (por numero exacto o descripción LIKE)
    // Para simplificar, buscamos en partes y hacemos un JOIN manual o con PostgREST
    // Haremos la consulta directamente a la vista combinada si estuviera, 
    // pero aquí lo haremos con múltiples queries para asegurar que funciona sin necesidad de vistas complejas en Supabase.
    
    let queryTrimmed = queryText.trim();
    
    // 1. Búsqueda exacta inicial
    let { data: parts, error: err1 } = await supabase
        .from('parts')
        .select('*')
        .or(`part_number.ilike.%${queryTrimmed}%,description.ilike.%${queryTrimmed}%`)
        .limit(5);

    // 2. Búsqueda inteligente (Fuzzy Search) si no hay resultados exactos
    if ((err1 || !parts || parts.length === 0) && queryTrimmed.includes(' ')) {
        const words = queryTrimmed.split(' ').filter(w => w.length > 2); // ignorar conectores cortos
        if (words.length > 0) {
            const orConditions = words.map(w => `description.ilike.%${w}%,part_number.ilike.%${w}%`).join(',');
            let { data: fuzzyParts } = await supabase
                .from('parts')
                .select('*')
                .or(orConditions);
                
            if (fuzzyParts && fuzzyParts.length > 0) {
                // Algoritmo de puntuación (Score)
                fuzzyParts.forEach(p => {
                    p.score = 0;
                    const descLower = (p.description || '').toLowerCase();
                    const partLower = (p.part_number || '').toLowerCase();
                    words.forEach(w => {
                        const wordLower = w.toLowerCase();
                        if (descLower.includes(wordLower)) p.score++;
                        if (partLower.includes(wordLower)) p.score += 2; // Pesa más si coincide con el número de parte
                    });
                });
                
                // Ordenar por las más relevantes y tomar las 5 mejores
                fuzzyParts.sort((a, b) => b.score - a.score);
                parts = fuzzyParts.slice(0, 5);
            }
        }
    }

    if (!parts || parts.length === 0) return [];

    // Ahora buscamos inventario de estas partes en el estado específico
    const partNumbers = parts.map(p => p.part_number);
    
    let { data: branches, error: err2 } = await supabase
        .from('branches')
        .select('id, name, address, agent_phone')
        .ilike('state', `%${state}%`);

    if (err2 || !branches || branches.length === 0) return [];

    const branchIds = branches.map(b => b.id);

    let { data: inventory, error: err3 } = await supabase
        .from('inventory')
        .select('*')
        .in('part_number', partNumbers)
        .in('branch_id', branchIds)
        .gt('stock', 0);

    if (err3 || !inventory) return [];

    // Ensamblar los resultados
    const results = [];
    parts.forEach(part => {
        const invForPart = inventory.filter(i => i.part_number === part.part_number);
        if (invForPart.length > 0) {
            const branchDetails = invForPart.map(inv => {
                const b = branches.find(br => br.id === inv.branch_id);
                return {
                    branch_id: b.id,
                    branch_name: b.name,
                    branch_address: b.address,
                    agent_phone: b.agent_phone,
                    stock: inv.stock
                };
            });
            results.push({
                part: part,
                inventory: branchDetails
            });
        }
    });

    return results;
}

// ---------------------------------------------------------
// FUNCIONES DE ANALÍTICA Y REPORTES
// ---------------------------------------------------------
async function logAnalytics(data) {
    if (!supabase) return;
    await supabase.from('analytics').insert([data]);
}

async function getStats() {
    if (!supabase) return { totalSearches: 0, totalOrders: 0, lostSales: 0, detailedMisses: [], detailedOrders: [] };
    
    const { count: searches } = await supabase.from('analytics').select('*', { count: 'exact', head: true });
    const { count: orders } = await supabase.from('analytics').select('*', { count: 'exact', head: true }).eq('ordered', true);
    const { count: lost } = await supabase.from('analytics').select('*', { count: 'exact', head: true }).eq('found', false);

    // Oportunidades Perdidas
    const { data: detailedMisses } = await supabase.from('analytics')
        .select('created_at, state, search_query')
        .eq('found', false)
        .order('created_at', { ascending: false });

    // Ventas concretadas (con JOIN a branches para el nombre)
    const { data: detailedOrders } = await supabase.from('analytics')
        .select(`created_at, state, search_query, branches(name)`)
        .eq('ordered', true)
        .order('created_at', { ascending: false });

    return {
        totalSearches: searches || 0,
        totalOrders: orders || 0,
        lostSales: lost || 0,
        detailedMisses: detailedMisses || [],
        detailedOrders: detailedOrders || []
    };
}

async function getClients() {
    if (!supabase) return [];
    const { data } = await supabase.from('users')
        .select('phone_number, client_name, client_number, real_phone')
        .not('client_name', 'is', null)
        .order('client_name', { ascending: true });
    return data || [];
}

async function updateClientNumber(phone, clientNumber) {
    if (!supabase) return false;
    const { error } = await supabase.from('users').update({ client_number: clientNumber }).eq('phone_number', phone);
    if (error) {
        console.error("Error actualizando número de cliente:", error);
        return false;
    }
    return true;
}

async function getAvailableStates() {
    if (!supabase) return [];
    const { data } = await supabase.from('branches').select('state');
    if (!data) return [];
    // Filtramos duplicados y nulos
    const states = [...new Set(data.map(b => b.state).filter(Boolean))];
    return states;
}

async function getBranchesDirectory(state) {
    if (!supabase) return "⚠️ Error de conexión a la base de datos.";
    
    let query = supabase.from('branches').select('name, address, agent_phone, contact').order('state', { ascending: true });
    
    if (state) {
        query = query.ilike('state', `%${state}%`);
    }
    
    const { data, error } = await query;
    if (error || !data || data.length === 0) {
        return "❌ No encontramos sucursales registradas en este momento" + (state ? ` para ${state}.` : ".");
    }
    
    let msg = `🏪 *DIRECTORIO DE SUCURSALES${state ? ` EN ${state.toUpperCase()}` : ""}*\n\n`;
    
    data.forEach(b => {
        msg += `📍 *${b.name}*\n`;
        if (b.address) msg += `🗺️ Dirección: ${b.address}\n`;
        if (b.contact) msg += `📞 Contacto: ${b.contact}\n`;
        msg += `\n`;
    });
    
    return msg;
}

async function deductInventory(branchId, partNumber, quantity) {
    if (!supabase) return false;
    
    const { data: inv } = await supabase
        .from('inventory')
        .select('id, stock')
        .eq('branch_id', branchId)
        .eq('part_number', partNumber)
        .maybeSingle();
        
    if (inv && inv.stock >= quantity) {
        const newStock = inv.stock - quantity;
        const { error } = await supabase.from('inventory').update({ stock: newStock }).eq('id', inv.id);
        if (error) console.error("Error deduciendo inventario:", error);
        return !error;
    }
    return false;
}

module.exports = {
    supabase,
    getUser,
    updateUser,
    searchParts,
    logAnalytics,
    getStats,
    getClients,
    updateClientNumber,
    getAvailableStates,
    getBranchesDirectory,
    deductInventory
};
