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
        const stopWords = new Set(['para', 'con', 'del', 'los', 'las', 'una', 'uno', 'por', 'sus', 'que', 'como', 'este', 'esta', 'estos', 'estas', 'sino', 'pero', 'mas', 'más', 'entre', 'sobre', 'hacia', 'hasta', 'desde']);
        
        // Separar por espacios, quitar acentos y limpiar puntuación
        const words = queryTrimmed.split(/\s+/)
            .map(w => w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,""))
            .filter(w => w.length > 2 && !stopWords.has(w));
            
        if (words.length > 0) {
            const orConditions = words.map(w => `description.ilike.%${w}%,part_number.ilike.%${w}%`).join(',');
            let { data: fuzzyParts } = await supabase
                .from('parts')
                .select('*')
                .or(orConditions);
                
            if (fuzzyParts && fuzzyParts.length > 0) {
                const firstWord = words[0]; // Sustantivo principal del producto
                const scoredParts = [];
                
                fuzzyParts.forEach(p => {
                    let score = 0;
                    let matchedCount = 0;
                    
                    const descNorm = (p.description || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    const partNorm = (p.part_number || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    
                    words.forEach((w, idx) => {
                        let wordMatched = false;
                        if (descNorm.includes(w)) {
                            score++;
                            wordMatched = true;
                        }
                        if (partNorm.includes(w)) {
                            score += 2; // Pesa más si coincide con el número de parte
                            wordMatched = true;
                        }
                        
                        if (wordMatched) {
                            matchedCount++;
                            if (idx === 0) {
                                score += 10; // Gran bonus si coincide con el sustantivo principal
                            }
                        }
                    });
                    
                    // REGLA DE RELEVANCIA ESTRICTA:
                    // Evita traer partes basura (ej. lija, ligas, enchufes) si el usuario buscó "bateria" o "balatas".
                    let isRelevant = false;
                    if (words.length === 1) {
                        isRelevant = matchedCount >= 1;
                    } else if (words.length === 2) {
                        isRelevant = matchedCount >= 2 || (matchedCount === 1 && descNorm.includes(firstWord));
                    } else {
                        // Si hay 3 o más palabras clave, requerimos al menos 2 coincidencias,
                        // Y que una de ellas sea el primer término de búsqueda (el sustantivo principal),
                        // O que se coincida con el 60% de los términos de búsqueda totales.
                        const matchesFirstWord = descNorm.includes(firstWord) || partNorm.includes(firstWord);
                        const matchRatio = matchedCount / words.length;
                        isRelevant = (matchedCount >= 2 && matchesFirstWord) || matchRatio >= 0.6;
                    }
                    
                    if (isRelevant) {
                        p.score = score;
                        p.matchedCount = matchedCount;
                        scoredParts.push(p);
                    }
                });
                
                // Ordenar por número de palabras clave coincidentes y luego por puntaje
                scoredParts.sort((a, b) => {
                    if (b.matchedCount !== a.matchedCount) {
                        return b.matchedCount - a.matchedCount;
                    }
                    return b.score - a.score;
                });
                
                parts = scoredParts.slice(0, 5);
            }
        }
    }

    if (!parts || parts.length === 0) return [];

    // Ahora buscamos inventario de estas partes en el estado específico
    const partNumbers = parts.map(p => p.part_number);
    
    let queryBranches = supabase
        .from('branches')
        .select('id, name, address, agent_phone, state');
        
    if (state) {
        queryBranches = queryBranches.ilike('state', `%${state}%`);
    }
    
    let { data: branches, error: err2 } = await queryBranches;

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
                    branch_state: b ? b.state : null,
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
