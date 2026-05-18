const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrImage = require('qrcode');
const { supabase, getUser, updateUser, searchParts, logAnalytics, getStats, getClients, updateClientNumber, getAvailableStates, getBranchesDirectory, deductInventory } = require('./db');

// ==========================================
// 1. CONFIGURACIÓN DEL SERVIDOR WEB (DASHBOARD)
// ==========================================
const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Obtener Estadísticas
app.get('/api/stats', async (req, res) => {
    const stats = await getStats();
    res.json(stats);
});

// API: Subir Excel de Inventario
app.post('/api/upload-inventory', upload.single('excel'), async (req, res) => {
    if (!req.file) return res.status(400).send('No se subió archivo.');
    
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        
        const partsMap = new Map();
        const inventoryToProcess = [];

        data.forEach(row => {
            const partNum = row['Numero_Parte']?.toString().trim();
            const desc = row['Descripcion']?.toString().trim();
            const price = parseFloat(row['Precio']);
            const branchId = parseInt(row['ID_Sucursal']);
            const stock = parseInt(row['Stock']);

            if (!partNum || !desc || isNaN(price) || isNaN(branchId) || isNaN(stock)) return;

            partsMap.set(partNum, {
                part_number: partNum,
                description: desc,
                price: price
            });

            inventoryToProcess.push({
                part_number: partNum,
                branch_id: branchId,
                stock: stock
            });
        });

        const partsArray = Array.from(partsMap.values());
        
        // 1. Insertar o Actualizar Piezas (Batch)
        if (partsArray.length > 0) {
            const { error: errParts } = await supabase.from('parts').upsert(partsArray, { onConflict: 'part_number' });
            if (errParts) throw errParts;
        }

        // 2. Procesar Inventario por Sucursal
        let updatedInventory = 0;
        for (const inv of inventoryToProcess) {
            const { data: existing } = await supabase
                .from('inventory')
                .select('id')
                .eq('part_number', inv.part_number)
                .eq('branch_id', inv.branch_id)
                .maybeSingle();

            if (existing) {
                await supabase.from('inventory').update({ stock: inv.stock }).eq('id', existing.id);
            } else {
                await supabase.from('inventory').insert(inv);
            }
            updatedInventory++;
        }
        
        console.log(`Excel procesado. ${partsArray.length} piezas, ${updatedInventory} registros de inventario.`);
        res.json({ success: true, message: `¡Inventario actualizado! ${partsArray.length} piezas y ${updatedInventory} registros de sucursales procesados exitosamente.` });
    } catch (error) {
        console.error("Error procesando Excel:", error);
        res.status(500).json({ error: "Error interno al procesar el archivo de Excel." });
    }
});

// API: Subir Excel de Catálogo de Sucursales
app.post('/api/upload-branches', upload.single('excel'), async (req, res) => {
    if (!req.file) return res.status(400).send('No se subió archivo.');
    
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        
        const branchesToProcess = [];

        data.forEach(row => {
            const id = parseInt(row['id']);
            const name = row['name']?.toString().trim();
            const state = row['state']?.toString().trim();
            const address = row['address']?.toString().trim();
            const agent_phone = row['agent_phone']?.toString().trim();
            const contact = row['contact']?.toString().trim();

            if (!name || !state || !agent_phone) return;

            branchesToProcess.push({
                ...(id ? { id } : {}),
                name,
                state,
                address: address || null,
                agent_phone,
                contact: contact || null
            });
        });

        if (branchesToProcess.length > 0) {
            const { error } = await supabase.from('branches').upsert(branchesToProcess, { onConflict: 'id' });
            if (error) throw error;
        }

        console.log(`Excel de Sucursales procesado. ${branchesToProcess.length} sucursales actualizadas.`);
        res.json({ success: true, message: `¡Catálogo de sucursales actualizado! (${branchesToProcess.length} registros)` });
    } catch (error) {
        console.error("Error procesando Excel de Sucursales:", error);
        res.status(500).json({ error: "Error al procesar el archivo de Sucursales." });
    }
});

// API: Subir Excel de Catálogo de Refacciones (Solo piezas)
app.post('/api/upload-parts', upload.single('excel'), async (req, res) => {
    if (!req.file) return res.status(400).send('No se subió archivo.');
    
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        
        const partsMap = new Map();

        data.forEach(row => {
            const partNum = row['Numero_Parte']?.toString().trim();
            const desc = row['Descripcion']?.toString().trim();
            const price = parseFloat(row['Precio']);

            if (!partNum || !desc || isNaN(price)) return;

            partsMap.set(partNum, {
                part_number: partNum,
                description: desc,
                price: price
            });
        });

        const partsArray = Array.from(partsMap.values());
        
        if (partsArray.length > 0) {
            const { error } = await supabase.from('parts').upsert(partsArray, { onConflict: 'part_number' });
            if (error) throw error;
        }

        console.log(`Excel de Refacciones procesado. ${partsArray.length} piezas actualizadas.`);
        res.json({ success: true, message: `¡Catálogo de refacciones actualizado! (${partsArray.length} piezas)` });
    } catch (error) {
        console.error("Error procesando Excel de Refacciones:", error);
        res.status(500).json({ error: "Error al procesar el archivo de Refacciones." });
    }
});

// API: Obtener Clientes
app.get('/api/clients', async (req, res) => {
    const clients = await getClients();
    res.json(clients);
});

// API: Actualizar Número de Cliente
app.post('/api/clients/:phone', async (req, res) => {
    const { clientNumber } = req.body;
    const success = await updateClientNumber(req.params.phone, clientNumber);
    res.json({ success });
});

let botStatus = 'disconnected';
let currentQR = null;

// API: Obtener Estado del Bot y QR
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, qr: currentQR });
});

app.listen(PORT, () => {
    console.log(`💻 Dashboard Web disponible en http://localhost:${PORT}`);
});

// ==========================================
// 2. CONFIGURACIÓN DEL BOT DE WHATSAPP
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    },
    webVersionCache: { type: 'none' }
});

client.on('qr', async (qr) => {
    console.log('\n======================================================');
    console.log('¡ESCANEA ESTE CÓDIGO QR PARA INICIAR EL BOT!');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
    
    botStatus = 'qr_ready';
    try {
        currentQR = await qrImage.toDataURL(qr);
    } catch (err) {
        console.error('Error generando imagen QR:', err);
    }
});

client.on('authenticated', () => {
    console.log('🔄 Autenticado correctamente. Sincronizando chats...');
    botStatus = 'authenticating';
    currentQR = null;
});

client.on('auth_failure', (msg) => {
    console.error('❌ Fallo en la autenticación:', msg);
    botStatus = 'auth_failure';
    currentQR = null;
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Sincronizando sesión de WhatsApp: ${percent}% - ${message}`);
    botStatus = 'loading';
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot conectado y listo.');
    botStatus = 'connected';
    currentQR = null;
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp Bot desconectado:', reason);
    botStatus = 'disconnected';
    currentQR = null;
});

// Cache temporal para guardar resultados de búsqueda por usuario
// para que puedan elegir la sucursal fácilmente.
const userSearchSessions = {};
const userCarts = {};
const userPendingItems = {};
const userLastActive = {}; // Rastreo de última interacción

// Diccionario básico de LADAS (puedes añadir más después)
const ladaMap = {
    '33': 'Jalisco', '81': 'Nuevo León', '55': 'Ciudad de México', '56': 'Ciudad de México',
    '322': 'Jalisco', '477': 'Guanajuato', '442': 'Querétaro', '222': 'Puebla',
    '664': 'Baja California', '998': 'Quintana Roo', '614': 'Chihuahua'
};

function detectStateFromPhone(phone) {
    if (phone.includes('@lid')) return null;
    let clean = phone.replace('@c.us', '');
    if (clean.startsWith('521')) clean = clean.substring(3);
    else if (clean.startsWith('52')) clean = clean.substring(2);
    else return null;

    const lada2 = clean.substring(0, 2);
    if (ladaMap[lada2]) return ladaMap[lada2];
    const lada3 = clean.substring(0, 3);
    if (ladaMap[lada3]) return ladaMap[lada3];
    return null;
}

// ==========================================
// ==========================================
// VALIDACIÓN DINÁMICA DE ESTADOS
// ==========================================
let availableStatesCache = [];

async function refreshAvailableStates() {
    try {
        const states = await getAvailableStates();
        availableStatesCache = states.map(s => ({
            original: s,
            normalized: normalizeString(s)
        }));
    } catch (e) {
        console.error("Error refrescando estados:", e);
    }
}

// Refrescar al inicio y cada hora (3600000 ms)
refreshAvailableStates();
setInterval(refreshAvailableStates, 3600000);

function normalizeString(str) {
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function getValidState(input) {
    const inputClean = input.trim();
    const idx = parseInt(inputClean);
    if (!isNaN(idx) && idx > 0 && idx <= availableStatesCache.length) {
        return availableStatesCache[idx - 1].original;
    }

    let normalizedInput = normalizeString(input);
    
    // Mapeo de alias comunes a nombres completos
    if (normalizedInput === 'cdmx' || normalizedInput === 'df') normalizedInput = 'ciudad de mexico';
    else if (normalizedInput === 'edomex' || normalizedInput === 'mexico') normalizedInput = 'estado de mexico';
    else if (normalizedInput === 'nl') normalizedInput = 'nuevo leon';
    else if (normalizedInput === 'qro') normalizedInput = 'queretaro';
    else if (normalizedInput === 'slp') normalizedInput = 'san luis potosi';

    const found = availableStatesCache.find(s => {
        const regex = new RegExp(`\\b${normalizedInput}\\b`);
        return regex.test(s.normalized) || s.normalized.includes(normalizedInput);
    });
    
    return found ? found.original : null;
}

client.on('message', async (message) => {
    if (message.from.includes('@g.us') || message.isStatus) return;
    
    const phone = message.from;
    const text = message.body.trim();
    
    console.log(`\n📩 [MENSAJE RECIBIDO] De: ${phone} | Texto: "${text}"`);
    console.log(`🔍 [DEBUG] author: ${message.author}, participant: ${message.id ? message.id.participant : 'N/A'}, remote: ${message.id ? message.id.remote : 'N/A'}`);
    
    let realPhone = null;
    try {
        const contact = await message.getContact();
        console.log(`🔍 [DEBUG CONTACT] number: ${contact.number}, id._serialized: ${contact.id ? contact.id._serialized : 'N/A'}`);
        if (contact && contact.id && contact.id._serialized) {
            realPhone = contact.id._serialized.replace('@c.us', '').replace('@lid', '');
        } else if (contact && contact.number) {
            realPhone = contact.number;
        }
        if (realPhone && realPhone.startsWith('521') && realPhone.length === 13) {
            realPhone = '52' + realPhone.substring(3);
        }
    } catch(e) {}
    
    const user = await getUser(phone);
    if (!user) {
        console.log(`❌ [ERROR] No se pudo obtener ni crear el usuario en la base de datos para ${phone}. Verifica tu conexión a Supabase y que las tablas existan.`);
        return; // Error de BD
    }
    
    // Guardar el número real en la base de datos para mostrarlo correctamente en el Dashboard
    if (realPhone && user.real_phone !== realPhone) {
        await updateUser(phone, { real_phone: realPhone });
        user.real_phone = realPhone;
    }
    
    let step = user.step || 'idle';
    console.log(`👤 Usuario en paso: ${step}`);
    
    // Verificación de inactividad (10 minutos)
    const now = Date.now();
    const TIMEOUT_MS = 10 * 60 * 1000;
    if (userLastActive[phone] && (now - userLastActive[phone]) > TIMEOUT_MS) {
        console.log(`⏱️ [TIMEOUT] Sesión de ${phone} expirada por inactividad (>10 min). Reiniciando al menú inicial.`);
        step = 'idle';
        await updateUser(phone, { step: 'idle' });
        delete userCarts[phone];
        delete userPendingItems[phone];
        delete userSearchSessions[phone];
    }
    userLastActive[phone] = now;
    
    // Comando para reiniciar la conversación en cualquier momento
    if (text.toLowerCase() === 'reiniciar' || text.toLowerCase() === 'menu') {
        await updateUser(phone, { step: 'idle' });
        console.log(`[ENVIANDO] a ${phone}: "🔄 Conversación reiniciada..."`);
        await client.sendMessage(phone, "🔄 *Conversación reiniciada*");
        step = 'idle';
        delete userCarts[phone];
        delete userPendingItems[phone];
        // Se deja continuar hacia abajo (no hay return) para que el bloque 'idle' se encargue de saludar.
    }

    // Comando para solicitar información de sucursales
    if (text.toUpperCase() === 'SUCURSALES' || text.toUpperCase() === 'DIRECCION' || text.toUpperCase() === 'DIRECCIÓN' || text.toUpperCase() === 'CONTACTO') {
        const branchesInfo = await getBranchesDirectory(user.current_state);
        console.log(`[ENVIANDO] a ${phone}: "Directorio de sucursales..."`);
        await client.sendMessage(phone, branchesInfo);
        return;
    }

    // Comando para cambiar de estado
    if (text.toUpperCase() === 'ESTADO') {
        await updateUser(phone, { step: 'asking_state', current_state: null });
        console.log(`[ENVIANDO] a ${phone}: "Cambiando de estado..."`);
        await client.sendMessage(phone, "Cambiando de estado... 📍\n¿En qué *Estado de la República* deseas hacer la consulta ahora?");
        return;
    }

    try {
        if (step === 'idle') {
            if (user.current_state) {
                // Ya tiene un estado recordado por compras/búsquedas previas
                await updateUser(phone, { step: 'asking_part' });
                
                let greeting = `¡Bienvenido al cotizador de refacciones! 🚗`;
                if (user.client_name) greeting = `¡Bienvenido de nuevo, *${user.client_name}*! 🚗`;
                
                greeting += `\n\nRealizaré las búsquedas en tu estado preferido: *${user.current_state}*.\n\nDime qué refacción buscas.\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona, o *SUCURSALES* para ver nuestro directorio._`;
                
                console.log(`[ENVIANDO] a ${phone}: "Estado recordado: ${user.current_state}"`);
                await client.sendMessage(phone, greeting);
            } else {
                const detectedState = detectStateFromPhone(phone);
                
                if (detectedState) {
                    // Autodetectó la LADA
                    await updateUser(phone, { current_state: detectedState, step: 'asking_part' });
                    console.log(`[ENVIANDO] a ${phone}: "¡Bienvenido... estado detectado: ${detectedState}"`);
                    await client.sendMessage(phone, `¡Bienvenido al cotizador de refacciones! 🚗\n\nPor tu código de área veo que nos contactas desde *${detectedState}*, así que estoy haciendo las consultas para ese estado.\n\nDime qué refacción buscas.\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona, o *SUCURSALES* para ver nuestro directorio._`);
                } else {
                    // No pudo autodetectar
                    await updateUser(phone, { step: 'asking_state' });
                    console.log(`[ENVIANDO] a ${phone}: "¡Bienvenido... ¿Estado?"`);
                    if (user.client_name && user.client_number) {
                        await client.sendMessage(phone, `¡Bienvenido de nuevo, *${user.client_name}*! 🚗\n\n¿De qué *Estado de la República* nos contactas hoy? (Ej: Jalisco, CDMX, Nuevo León)`);
                    } else {
                        await client.sendMessage(phone, "¡Bienvenido al cotizador de refacciones! 🚗\n\n¿De qué *Estado de la República* nos contactas? (Ej: Jalisco, Nuevo León, CDMX)");
                    }
                }
            }
        } 
        else if (step === 'asking_state') {
            const validState = getValidState(text);
            
            if (!validState) {
                console.log(`[ENVIANDO] a ${phone}: "⚠️ Estado no válido - Mostrando opciones"`);
                
                let stateOptionsMsg = "⚠️ No logramos reconocer ese estado.\n\nPor favor, responde con el *NÚMERO* o el *NOMBRE* de tu estado en esta lista:\n\n";
                
                if (availableStatesCache.length === 0) {
                    stateOptionsMsg = "⚠️ Lo siento, en este momento nuestro sistema no cuenta con estados registrados.";
                } else {
                    availableStatesCache.forEach((s, idx) => {
                        stateOptionsMsg += `[${idx + 1}] ${s.original}\n`;
                    });
                }
                
                await client.sendMessage(phone, stateOptionsMsg);
                return;
            }
            
            // Guardar estado validado y preguntar pieza
            await updateUser(phone, { current_state: validState, step: 'asking_part' });
            console.log(`[ENVIANDO] a ${phone}: "¡Perfecto! Buscaremos en ${validState}..."`);
            await client.sendMessage(phone, `¡Perfecto! Buscaremos en *${validState}*.\n\nDime qué refacción buscas.\n\n💡 _Para buscar en otro estado en cualquier momento, envía la palabra *ESTADO*_`);
        }
        else if (step === 'asking_part') {
            // Buscar pieza
            const state = user.current_state;
            console.log(`[ENVIANDO] a ${phone}: "🔍 Buscando..."`);
            await client.sendMessage(phone, "🔍 Buscando en nuestro inventario...");
            
            const results = await searchParts(text, state);
            
            if (results.length === 0) {
                await logAnalytics({ phone_number: phone, search_query: text, found: false, state: state });
                console.log(`[ENVIANDO] a ${phone}: "❌ No encontrado"`);
                await client.sendMessage(phone, `❌ Lo siento, no pudimos encontrar "${text}" en sucursales de ${state}.\n\nIntenta escribir solo el número de parte, o envía "Reiniciar" para buscar en otro estado.`);
            } else {
                await logAnalytics({ phone_number: phone, search_query: text, found: true, state: state });
                
                // Formatear respuesta y restar lo que ya está en el carrito
                const cart = userCarts[phone] || [];
                let validItemsFound = 0;
                
                let replyMsg = `✅ *Resultados encontrados en ${state}:*\n\n`;
                let optionsData = {};
                let optionCounter = 1;
                
                results.forEach((item) => {
                    let branchesWithStock = [];
                    
                    item.inventory.forEach(inv => {
                        let cartQuantity = 0;
                        for (const cartItem of cart) {
                            if (cartItem.part.part_number === item.part.part_number && cartItem.branch.branch_id === inv.branch_id) {
                                cartQuantity += cartItem.quantity;
                            }
                        }
                        const actualStock = inv.stock - cartQuantity;
                        
                        if (actualStock > 0) {
                            branchesWithStock.push({ ...inv, stock: actualStock });
                        }
                    });
                    
                    if (branchesWithStock.length > 0) {
                        validItemsFound++;
                        replyMsg += `📦 *${item.part.part_number}* - ${item.part.description} ($${item.part.price} MXN)\n`;
                        branchesWithStock.forEach(inv => {
                            replyMsg += `   [${optionCounter}] ${inv.branch_name} (${inv.stock} disp.)\n`;
                            optionsData[optionCounter] = { part: item.part, branch: inv };
                            optionCounter++;
                        });
                        replyMsg += `\n`;
                    }
                });
                
                if (validItemsFound === 0) {
                    console.log(`[ENVIANDO] a ${phone}: "❌ Sin stock suficiente (ya está en carrito)"`);
                    await client.sendMessage(phone, `⚠️ La refacción "${text}" existe en ${state}, pero el inventario disponible ya lo tienes reservado en tu carrito actual.\n\nIntenta buscar otra pieza o envía "Reiniciar".`);
                } else {
                    replyMsg += `👉 *Responde con el NÚMERO* de la sucursal para pedir la pieza, o envía "Reiniciar" para nueva búsqueda.`;
                    
                    userSearchSessions[phone] = optionsData;
                    await updateUser(phone, { step: 'choosing_branch' });
                    console.log(`[ENVIANDO] a ${phone}: Resultados de búsqueda`);
                    await client.sendMessage(phone, replyMsg);
                }
            }
        }
        else if (step === 'choosing_branch') {
            const optionIndex = parseInt(text);
            const sessionData = userSearchSessions[phone];
            
            if (sessionData && sessionData[optionIndex]) {
                const selection = sessionData[optionIndex];
                userPendingItems[phone] = { part: selection.part, branch: selection.branch };
                await updateUser(phone, { step: 'asking_quantity' });
                console.log(`[ENVIANDO] a ${phone}: "¿Cuántas piezas necesitas?"`);
                await client.sendMessage(phone, "¿Cuántas piezas necesitas? (Ingresa solo el número)");
            } else {
                console.log(`[ENVIANDO] a ${phone}: "⚠️ Opción inválida"`);
                await client.sendMessage(phone, "⚠️ Opción inválida. Responde con el número de la lista o 'Reiniciar'.");
            }
        }
        else if (step === 'asking_quantity') {
            if (text.toUpperCase().trim() === 'REGRESAR') {
                const sessionData = userSearchSessions[phone];
                if (!sessionData) {
                    await client.sendMessage(phone, "⚠️ Tu búsqueda expiró. Por favor, escribe 'Reiniciar' e intenta de nuevo.");
                    return;
                }
                
                let replyMsg = `✅ Volviendo a los resultados de tu búsqueda:\n`;
                let currentPartNumber = null;
                const numOptions = Object.keys(sessionData).length;
                
                for (let i = 1; i <= numOptions; i++) {
                    const val = sessionData[i];
                    if (!val) continue;
                    if (currentPartNumber !== val.part.part_number) {
                        currentPartNumber = val.part.part_number;
                        replyMsg += `\n📦 *${val.part.part_number}* - ${val.part.description} ($${val.part.price})\n`;
                    }
                    replyMsg += `   [${i}] ${val.branch.branch_name} (${val.branch.stock} disp.)\n`;
                }
                replyMsg += `\n👉 *Responde con el NÚMERO* de la sucursal para pedir la pieza, o envía "Reiniciar" para empezar desde cero.`;
                
                await updateUser(phone, { step: 'choosing_branch' });
                delete userPendingItems[phone];
                await client.sendMessage(phone, replyMsg);
                return;
            }

            const quantity = parseInt(text);
            if (isNaN(quantity) || quantity <= 0) {
                await client.sendMessage(phone, "⚠️ Por favor ingresa un número válido (ej. 1, 2, 3), o responde *REGRESAR* para ver las opciones.");
                return;
            }
            
            const pendingItem = userPendingItems[phone];
            if (!pendingItem) {
                await client.sendMessage(phone, "⚠️ Hubo un error recuperando tu pieza. Por favor, escribe 'Reiniciar'.");
                return;
            }

            if (quantity > pendingItem.branch.stock) {
                await client.sendMessage(phone, `⚠️ Lo sentimos, actualmente solo tenemos *${pendingItem.branch.stock}* pieza(s) disponible(s) en esta sucursal.\n\nPor favor ingresa una cantidad menor o igual a ${pendingItem.branch.stock}, o responde *REGRESAR* para ver las opciones de sucursales nuevamente.`);
                return;
            }

            if (!userCarts[phone]) userCarts[phone] = [];
            userCarts[phone].push({ ...pendingItem, quantity });
            
            delete userPendingItems[phone];
            delete userSearchSessions[phone];
            
            await updateUser(phone, { step: 'asking_more' });
            await client.sendMessage(phone, `✅ ¡Pieza agregada a tu carrito! (Llevas ${userCarts[phone].length} artículo/s).\n\n¿Deseas agregar otra refacción a tu pedido?\nResponde *SI* para buscar otra, *NO* para finalizar tu pedido, o *CANCELAR* para borrar el carrito.`);
        }
        else if (step === 'asking_more') {
            const res = text.toUpperCase().trim();
            if (res === 'SI' || res === 'SÍ' || res === 'S') {
                await updateUser(phone, { step: 'asking_part' });
                await client.sendMessage(phone, "Dime qué *otra refacción* buscas:\n\n💡 _(Si deseas cambiar de zona, envía la palabra ESTADO)_");
            } else if (res === 'NO' || res === 'N') {
                if (user.client_name && user.client_number) {
                    await processOrder(phone, user.client_name, user.client_number, user.current_state, message);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    await client.sendMessage(phone, "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?");
                }
            } else if (res === 'CANCELAR') {
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                await client.sendMessage(phone, "🗑️ Carrito vaciado correctamente.\n\nDime qué refacción buscas ahora:");
            } else {
                await client.sendMessage(phone, "⚠️ Por favor responde *SI*, *NO* o *CANCELAR*.");
            }
        }
        else if (step === 'asking_name') {
            const clientName = text;
            await updateUser(phone, { client_name: clientName });
            await processOrder(phone, clientName, 'Nuevo Registro', user.current_state, message);
        }
    } catch (error) {
        console.error("Error procesando mensaje:", error);
    }
});

// Helper Function para procesar la orden final (CARRITO)
async function processOrder(phone, clientName, clientNumber, currentState, message) {
    const cart = userCarts[phone] || [];
    if (cart.length === 0) return;

    let clientTicket = `¡Excelente! 🎉 Aquí tienes el resumen de tu pedido:\n\n`;
    let grandTotal = 0;
    const ordersByAgent = {};

    cart.forEach(item => {
        const { part, branch, quantity } = item;
        const price = part.price ? parseFloat(part.price) : 0;
        const itemTotal = price * quantity;
        grandTotal += itemTotal;
        
        clientTicket += `▪ ${quantity}x ${part.description} (Número de Parte: ${part.part_number}) - $${itemTotal.toFixed(2)} MXN (Suc. ${branch.branch_name})\n`;

        const agentPhoneStr = branch.agent_phone || '8112418248';
        if (!ordersByAgent[agentPhoneStr]) ordersByAgent[agentPhoneStr] = [];
        ordersByAgent[agentPhoneStr].push(item);
    });

    clientTicket += `\n------------------\n`;
    clientTicket += `*Total a pagar: $${grandTotal.toFixed(2)} MXN* _(ya incluye IVA)_\n\n`;
    clientTicket += `En breve nuestros agentes se comunicarán contigo para confirmar tu pedido.`;

    console.log(`[ENVIANDO TICKETS] a ${phone}`);
    await client.sendMessage(phone, clientTicket);

    // Obtener teléfono real del cliente para el link wa.me
    let cleanClientPhone = phone.replace('@c.us', '').replace('@lid', '');
    if (message) {
        try {
            const contact = await message.getContact();
            if (contact && contact.id && contact.id._serialized) {
                cleanClientPhone = contact.id._serialized.replace('@c.us', '').replace('@lid', '');
            } else if (contact && contact.number) {
                cleanClientPhone = contact.number;
            }
        } catch (e) {}
    }
    if (cleanClientPhone.startsWith('521') && cleanClientPhone.length === 13) {
        cleanClientPhone = '52' + cleanClientPhone.substring(3);
    }

    // Mandar mensaje a cada agente/sucursal de forma independiente
    for (const [agentPhone, items] of Object.entries(ordersByAgent)) {
        let agentMsg = `🔔 *NUEVO PEDIDO DESDE WHATSAPP BOT*\n\n`;
        agentMsg += `*Cliente (Wa):* wa.me/${cleanClientPhone}\n`;
        agentMsg += `*Facturar a:* ${clientName}\n`;
        agentMsg += `*No. Cliente:* ${clientNumber || 'Nuevo Registro'}\n\n`;
        agentMsg += `*Piezas solicitadas a tu sucursal:*\n`;

        let agentTotal = 0;
        items.forEach(item => {
            const price = item.part.price ? parseFloat(item.part.price) : 0;
            const itemTotal = price * item.quantity;
            agentTotal += itemTotal;
            agentMsg += `- ${item.quantity}x ${item.part.description} (Número de Parte: ${item.part.part_number}) - Sucursal: ${item.branch.branch_name}\n`;
        });
        
        agentMsg += `\n*Subtotal (con IVA):* $${agentTotal.toFixed(2)} MXN\n\n`;
        agentMsg += `👉 Toca el enlace del cliente arriba para abrir el chat.`;

        let cleanAgent = agentPhone.replace('@c.us', '').replace('+', '').replace(/\s+/g, '').trim();
        if (cleanAgent.length === 10) cleanAgent = `52${cleanAgent}`;

        try {
            let numberId = await client.getNumberId(cleanAgent);
            if (!numberId && cleanAgent.startsWith('52') && cleanAgent.length === 12) {
                numberId = await client.getNumberId(`521${cleanAgent.substring(2)}`);
            } else if (!numberId && cleanAgent.startsWith('521') && cleanAgent.length === 13) {
                numberId = await client.getNumberId(`52${cleanAgent.substring(3)}`);
            }

            if (numberId) {
                await client.sendMessage(numberId._serialized, agentMsg);
            } else {
                await client.sendMessage(`${cleanAgent}@c.us`, agentMsg);
            }
        } catch (error) {
            console.error(`⚠️ No se pudo enviar mensaje al agente (${cleanAgent}).`);
        }
    }

    // Guardar en analíticas y descontar inventario iterando sobre el carrito
    for (const item of cart) {
        await logAnalytics({ phone_number: phone, search_query: item.part.part_number, found: true, ordered: true, branch_id: item.branch.branch_id, state: currentState });
        await deductInventory(item.branch.branch_id, item.part.part_number, item.quantity);
    }

    await updateUser(phone, { step: 'idle' });
    delete userCarts[phone];
}

client.initialize();
