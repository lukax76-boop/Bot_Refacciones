require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const LOCAL_USERS_FILE = path.join(__dirname, 'dashboard_users.json');


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
    
    // Buscar la refacción (por número exacto o descripción LIKE)
    // Para simplificar, buscamos en partes y hacemos un JOIN manual o con PostgREST.
    
    let queryTrimmed = queryText.trim();
    
    // Escapar comas para evitar que PostgREST or() falle con sintaxis inválida
    const safeQuery = queryTrimmed.replace(/,/g, '');
    const cleanQuery = safeQuery.replace(/[^A-Z0-9]/ig, '');
    let wildcardQuery = '';
    if (cleanQuery.length > 1) {
        const chunks = cleanQuery.split(/([A-Z]+|[0-9]+)/i).filter(Boolean);
        wildcardQuery = chunks.join('%');
    }

    let orConditions = `part_number.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%`;
    if (cleanQuery && cleanQuery !== safeQuery) {
        orConditions += `,part_number.ilike.%${cleanQuery}%`;
    }
    if (wildcardQuery && wildcardQuery !== safeQuery && wildcardQuery !== cleanQuery) {
        orConditions += `,part_number.ilike.%${wildcardQuery}%`;
    }
    
    // 1. Búsqueda exacta inicial con soporte de variaciones
    let { data: parts, error: err1 } = await supabase
        .from('parts')
        .select('*')
        .or(orConditions)
        .limit(10);

    if (parts && parts.length > 0) {
        // Ordenar los resultados para favorecer la coincidencia exacta
        const qNorm = cleanQuery.toLowerCase();
        parts.sort((a, b) => {
            const aNumNorm = (a.part_number || '').replace(/[^A-Z0-9]/ig, '').toLowerCase();
            const bNumNorm = (b.part_number || '').replace(/[^A-Z0-9]/ig, '').toLowerCase();
            
            // Coincidencia exacta del número de parte normalizado tiene máxima prioridad
            const aExact = aNumNorm === qNorm;
            const bExact = bNumNorm === qNorm;
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            
            // Coincidencia exacta del part_number original (incluyendo guiones)
            const aOrigExact = a.part_number?.toLowerCase() === queryTrimmed.toLowerCase();
            const bOrigExact = b.part_number?.toLowerCase() === queryTrimmed.toLowerCase();
            if (aOrigExact && !bOrigExact) return -1;
            if (!aOrigExact && bOrigExact) return 1;
            
            return 0;
        });
        
        // Limitar a los 5 mejores resultados
        parts = parts.slice(0, 5);
    }

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
    let searches = 0, orders = 0, lost = 0;
    let detailedMisses = [], detailedOrders = [];
    
    if (supabase) {
        try {
            const { count: s } = await supabase.from('analytics').select('*', { count: 'exact', head: true });
            const { count: o } = await supabase.from('analytics').select('*', { count: 'exact', head: true }).eq('ordered', true);
            const { count: l } = await supabase.from('analytics').select('*', { count: 'exact', head: true }).eq('found', false);
            
            searches = s || 0;
            orders = o || 0;
            lost = l || 0;

            const { data: dm } = await supabase.from('analytics')
                .select('created_at, state, search_query')
                .eq('found', false)
                .order('created_at', { ascending: false })
                .limit(100);
            detailedMisses = dm || [];

            const { data: doList } = await supabase.from('analytics')
                .select(`created_at, state, search_query, branches(name)`)
                .eq('ordered', true)
                .order('created_at', { ascending: false })
                .limit(100);
            detailedOrders = doList || [];
        } catch (e) {
            console.error("Error consultando analítica en Supabase:", e);
        }
    }

    // 1. Obtener conteo de visitas en Supabase (si existe la tabla)
    let dbVisitsCount = 0;
    if (supabase) {
        try {
            const { count } = await supabase.from('page_visits').select('*', { count: 'exact', head: true });
            dbVisitsCount = count || 0;
        } catch (e) {
            // La tabla no existe aún, se ignora el error
        }
    }

    // 2. Obtener conteo de visitas local
    let localVisitsCount = 0;
    try {
        const file = path.join(__dirname, 'visits.json');
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            const visits = JSON.parse(content || '[]');
            localVisitsCount = visits.length;
        }
    } catch (e) {}

    const totalVisits = dbVisitsCount + localVisitsCount;

    return {
        totalSearches: searches,
        totalOrders: orders,
        lostSales: lost,
        totalVisits: totalVisits,
        detailedMisses,
        detailedOrders
    };
}

async function getClients() {
    if (!supabase) return [];
    const { data } = await supabase.from('users')
        .select('phone_number, client_name, client_number, real_phone, last_interaction')
        .not('client_name', 'is', null)
        .order('last_interaction', { ascending: false })
        .limit(100);
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
        if (b.address) {
            msg += `🗺️ Dirección: ${b.address}\n`;
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.name + ' ' + b.address)}`;
            msg += `📍 Google Maps: ${mapsUrl}\n`;
        }
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

// ---------------------------------------------------------
// FUNCIONES DE ADMINISTRACIÓN DE USUARIOS (DASHBOARD)
// ---------------------------------------------------------

function hashPassword(password) {
    return crypto.createHash('sha256').update(password + 'refacciones_salt_123').digest('hex');
}

// Helpers locales para leer y escribir el archivo JSON fallback
function readLocalUsers() {
    try {
        if (fs.existsSync(LOCAL_USERS_FILE)) {
            const content = fs.readFileSync(LOCAL_USERS_FILE, 'utf8');
            return JSON.parse(content);
        }
    } catch (e) {
        console.error("❌ Error leyendo archivo local de usuarios:", e);
    }
    return [];
}

function writeLocalUsers(users) {
    try {
        fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error("❌ Error escribiendo archivo local de usuarios:", e);
        return false;
    }
}

async function getDashboardUsers() {
    if (supabase) {
        try {
            const { data, error } = await supabase.from('dashboard_users').select('id, username, role, created_at').order('username', { ascending: true });
            if (!error) {
                return data || [];
            }
            console.warn("⚠️ Supabase 'dashboard_users' no disponible, usando fallback local:", error.message || error);
        } catch (err) {
            console.warn("⚠️ Excepción consultando 'dashboard_users' en Supabase, usando fallback local:", err.message);
        }
    }
    
    // Fallback local
    const users = readLocalUsers();
    // Retornamos sin hashes por seguridad en el listado
    return users.map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at }));
}

async function createDashboardUser(username, password, role) {
    const hash = hashPassword(password);
    const cleanUsername = username.trim().toLowerCase();
    
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('dashboard_users')
                .insert([{ username: cleanUsername, password_hash: hash, role }])
                .select('id, username, role, created_at');
            if (!error) {
                return { success: true, data: data[0] };
            }
            // Si el error es de violación de unicidad
            if (error.code === '23505') {
                return { success: false, error: 'El nombre de usuario ya está registrado.' };
            }
            console.warn("⚠️ Error en Supabase createDashboardUser, usando fallback local:", error.message || error);
        } catch (err) {
            console.warn("⚠️ Excepción en Supabase createDashboardUser, usando fallback local:", err.message);
        }
    }
    
    // Fallback local
    const users = readLocalUsers();
    const exists = users.some(u => u.username === cleanUsername);
    if (exists) {
        return { success: false, error: 'El nombre de usuario ya está registrado.' };
    }
    
    const newUser = {
        id: Date.now(),
        username: cleanUsername,
        password_hash: hash,
        role: role,
        created_at: new Date().toISOString()
    };
    users.push(newUser);
    writeLocalUsers(users);
    
    // Retornamos sin hash
    const { password_hash, ...safeUser } = newUser;
    return { success: true, data: safeUser };
}

async function deleteDashboardUser(username) {
    const cleanUsername = username.trim().toLowerCase();
    
    if (supabase) {
        try {
            const { error } = await supabase.from('dashboard_users').delete().eq('username', cleanUsername);
            if (!error) {
                return { success: true };
            }
            console.warn("⚠️ Error en Supabase deleteDashboardUser, usando fallback local:", error.message || error);
        } catch (err) {
            console.warn("⚠️ Excepción en Supabase deleteDashboardUser, usando fallback local:", err.message);
        }
    }
    
    // Fallback local
    let users = readLocalUsers();
    const initialLength = users.length;
    users = users.filter(u => u.username !== cleanUsername);
    if (users.length === initialLength) {
        return { success: false, error: 'Usuario no encontrado.' };
    }
    writeLocalUsers(users);
    return { success: true };
}

async function updateDashboardUserRole(username, role) {
    const cleanUsername = username.trim().toLowerCase();
    
    if (supabase) {
        try {
            const { error } = await supabase.from('dashboard_users').update({ role }).eq('username', cleanUsername);
            if (!error) {
                return { success: true };
            }
            console.warn("⚠️ Error en Supabase updateDashboardUserRole, usando fallback local:", error.message || error);
        } catch (err) {
            console.warn("⚠️ Excepción en Supabase updateDashboardUserRole, usando fallback local:", err.message);
        }
    }
    
    // Fallback local
    const users = readLocalUsers();
    const user = users.find(u => u.username === cleanUsername);
    if (!user) {
        return { success: false, error: 'Usuario no encontrado.' };
    }
    user.role = role;
    writeLocalUsers(users);
    return { success: true };
}

async function resetDashboardUserPassword(username, newPassword) {
    const cleanUsername = username.trim().toLowerCase();
    const hash = hashPassword(newPassword);
    
    if (supabase) {
        try {
            const { error } = await supabase.from('dashboard_users').update({ password_hash: hash }).eq('username', cleanUsername);
            if (!error) {
                return { success: true };
            }
            console.warn("⚠️ Error en Supabase resetDashboardUserPassword, usando fallback local:", error.message || error);
        } catch (err) {
            console.warn("⚠️ Excepción en Supabase resetDashboardUserPassword, usando fallback local:", err.message);
        }
    }
    
    // Fallback local
    const users = readLocalUsers();
    const user = users.find(u => u.username === cleanUsername);
    if (!user) {
        return { success: false, error: 'Usuario no encontrado.' };
    }
    user.password_hash = hash;
    writeLocalUsers(users);
    return { success: true };
}

async function authenticateDashboardUser(username, password) {
    const cleanUsername = username.trim().toLowerCase();
    const hash = hashPassword(password);
    
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('dashboard_users')
                .select('*')
                .eq('username', cleanUsername)
                .maybeSingle();
            
            if (!error && data) {
                if (data.password_hash === hash) {
                    return { success: true, user: { username: data.username, role: data.role } };
                } else {
                    return { success: false, error: 'Contraseña incorrecta.' };
                }
            }
            // Si el error no es nulo y no es por falta de tabla, logueamos
            if (error) {
                console.warn("⚠️ Error en Supabase authenticateDashboardUser, usando fallback local:", error.message || error);
            }
        } catch (err) {
            console.warn("⚠️ Excepción en Supabase authenticateDashboardUser, usando fallback local:", err.message);
        }
    }
    
    // Fallback local
    const users = readLocalUsers();
    const user = users.find(u => u.username === cleanUsername);
    if (user) {
        if (user.password_hash === hash) {
            return { success: true, user: { username: user.username, role: user.role } };
        } else {
            return { success: false, error: 'Contraseña incorrecta.' };
        }
    }
    
    return { success: false, error: 'Usuario no encontrado.' };
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
    deductInventory,
    getDashboardUsers,
    createDashboardUser,
    deleteDashboardUser,
    updateDashboardUserRole,
    resetDashboardUserPassword,
    authenticateDashboardUser
};

