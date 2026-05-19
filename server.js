const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
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
// ==========================================
// 2. CONFIGURACIÓN DEL BOT DE WHATSAPP (META CLOUD API)
// ==========================================
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Cache temporal
const userSearchSessions = {};
const userCarts = {};
const userPendingItems = {};
const userLastActive = {}; 

const ladaMap = {
    '33': 'Jalisco', '81': 'Nuevo León', '55': 'Ciudad de México', '56': 'Ciudad de México',
    '322': 'Jalisco', '477': 'Guanajuato', '442': 'Querétaro', '222': 'Puebla',
    '664': 'Baja California', '998': 'Quintana Roo', '614': 'Chihuahua'
};

function detectStateFromPhone(phone) {
    let clean = phone;
    if (clean.startsWith('521')) clean = clean.substring(3);
    else if (clean.startsWith('52')) clean = clean.substring(2);
    else return null;

    const lada2 = clean.substring(0, 2);
    if (ladaMap[lada2]) return ladaMap[lada2];
    const lada3 = clean.substring(0, 3);
    if (ladaMap[lada3]) return ladaMap[lada3];
    return null;
}

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
refreshAvailableStates();
setInterval(refreshAvailableStates, 3600000);

function normalizeString(str) {
    return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function getValidState(input) {
    const inputClean = input.trim();
    const idx = parseInt(inputClean);
    if (!isNaN(idx) && idx > 0 && idx <= availableStatesCache.length) {
        return availableStatesCache[idx - 1].original;
    }
    let normalizedInput = normalizeString(input);
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

// Helper: Enviar mensaje mediante Meta Cloud API
async function sendMetaMessage(phone, content, type = 'text', interactiveOptions = null) {
    const token = process.env.META_ACCESS_TOKEN;
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    if(!token || !phoneId) {
        console.error("Faltan META_ACCESS_TOKEN o META_PHONE_NUMBER_ID");
        return;
    }

    let to = phone.replace('@c.us', '').replace('@lid', '').replace(/\+/g, '').trim();
    if (to.length === 10) to = '52' + to;

    let data = {
        messaging_product: "whatsapp",
        to: to,
        type: type
    };

    if (type === 'text') {
        data.text = { body: content };
    } else if (type === 'interactive') {
        data.interactive = interactiveOptions;
    }

    try {
        await axios.post(`https://graph.facebook.com/v19.0/${phoneId}/messages`, data, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error("Error sending Meta Message:", e.response?.data || e.message);
    }
}

// Helper: Transcribir Audio con OpenAI Whisper
async function transcribeAudio(audioId) {
    try {
        const token = process.env.META_ACCESS_TOKEN;
        const mediaRes = await axios.get(`https://graph.facebook.com/v19.0/${audioId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const mediaUrl = mediaRes.data.url;
        
        const audioRes = await axios.get(mediaUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'stream'
        });
        
        const tempPath = path.join(__dirname, `temp_${Date.now()}.ogg`);
        const writer = fs.createWriteStream(tempPath);
        audioRes.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        console.log("Audio descargado, enviando a Whisper...");
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: "whisper-1",
            language: "es"
        });
        
        fs.unlinkSync(tempPath);
        return transcription.text;
    } catch(e) {
        console.error("Error transcribing audio:", e.response?.data || e.message);
        return null;
    }
}

// WEBHOOK DE META CLOUD API
app.get('/webhook', (req, res) => {
    const verify_token = process.env.META_WEBHOOK_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === verify_token) {
            console.log('WEBHOOK VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Responder OK inmediatamente a Meta
    
    const body = req.body;
    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const contact = body.entry[0].changes[0].value.contacts[0];
            
            const phone = message.from; 
            const senderName = contact ? contact.profile.name : 'Usuario';
            
            let text = "";
            let audioId = null;
            
            if (message.type === 'text') {
                text = message.text.body;
            } else if (message.type === 'interactive') {
                if (message.interactive.type === 'button_reply') {
                    text = message.interactive.button_reply.id;
                } else if (message.interactive.type === 'list_reply') {
                    text = message.interactive.list_reply.id;
                }
            } else if (message.type === 'audio') {
                audioId = message.audio.id;
                text = await transcribeAudio(audioId);
                if (!text) {
                    await sendMetaMessage(phone, "⚠️ Lo siento, no pude entender el audio. ¿Podrías escribir tu mensaje?");
                    return;
                }
                console.log(`[AUDIO TRANSCRITO]: "${text}"`);
            } else {
                return; // Ignorar imagenes, stickers, etc.
            }
            
            if(text) {
                await processMessageLogic(phone, text, senderName);
            }
        }
    }
});

async function processMessageLogic(phone, text, senderName) {
    console.log(`\n📩 [MENSAJE RECIBIDO] De: ${phone} | Texto: "${text}"`);
    
    const user = await getUser(phone);
    if (!user) {
        console.log(`❌ [ERROR] Base de datos falló.`);
        return; 
    }
    
    let step = user.step || 'idle';
    
    // Verificación de inactividad
    const now = Date.now();
    if (userLastActive[phone] && (now - userLastActive[phone]) > 600000) {
        console.log(`⏱️ Sesión expirada.`);
        step = 'idle';
        await updateUser(phone, { step: 'idle' });
        delete userCarts[phone];
        delete userPendingItems[phone];
        delete userSearchSessions[phone];
    }
    userLastActive[phone] = now;
    
    const lowerText = text.toLowerCase().trim();
    const greetings = ['hola', 'hola!', 'ola', 'buenos dias', 'buenos días', 'buenas tardes', 'buenas noches', 'buenas', 'que tal', 'qué tal', 'reiniciar', 'menu', 'menú'];
    
    if (greetings.includes(lowerText)) {
        await updateUser(phone, { step: 'idle' });
        if (lowerText === 'reiniciar' || lowerText === 'menu' || lowerText === 'menú') {
            await sendMetaMessage(phone, "🔄 *Conversación reiniciada*");
        }
        step = 'idle';
        delete userCarts[phone];
        delete userPendingItems[phone];
        delete userSearchSessions[phone];
    }

    if (text.toUpperCase() === 'SUCURSALES' || text.toUpperCase() === 'DIRECCION' || text.toUpperCase() === 'DIRECCIÓN' || text.toUpperCase() === 'CONTACTO') {
        const branchesInfo = await getBranchesDirectory(user.current_state);
        await sendMetaMessage(phone, branchesInfo);
        return;
    }

    if (text.toUpperCase() === 'ESTADO') {
        await updateUser(phone, { step: 'asking_state', current_state: null });
        await sendMetaMessage(phone, "Cambiando de estado... 📍\n¿En qué *Estado de la República* deseas hacer la consulta ahora?");
        return;
    }

    try {
        if (step === 'idle') {
            if (user.current_state) {
                await updateUser(phone, { step: 'asking_part' });
                let greeting = `¡Bienvenido al cotizador de refacciones! 🚗`;
                if (user.client_name) greeting = `¡Bienvenido de nuevo, *${user.client_name}*! 🚗`;
                greeting += `\n\nRealizaré las búsquedas en tu estado preferido: *${user.current_state}*.\n\nDime qué refacción buscas (puedes enviar un mensaje de voz o texto).\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona, o *SUCURSALES* para ver nuestro directorio._`;
                await sendMetaMessage(phone, greeting);
            } else {
                const detectedState = detectStateFromPhone(phone);
                if (detectedState) {
                    await updateUser(phone, { current_state: detectedState, step: 'asking_part' });
                    await sendMetaMessage(phone, `¡Bienvenido al cotizador de refacciones! 🚗\n\nPor tu código de área veo que nos contactas desde *${detectedState}*.\n\nDime qué refacción buscas (audio o texto).\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona._`);
                } else {
                    await updateUser(phone, { step: 'asking_state' });
                    if (user.client_name && user.client_number) {
                        await sendMetaMessage(phone, `¡Bienvenido de nuevo, *${user.client_name}*! 🚗\n\n¿De qué *Estado de la República* nos contactas hoy?`);
                    } else {
                        await sendMetaMessage(phone, "¡Bienvenido al cotizador de refacciones! 🚗\n\n¿De qué *Estado de la República* nos contactas?");
                    }
                }
            }
        } 
        else if (step === 'asking_state') {
            const validState = getValidState(text);
            if (!validState) {
                let stateOptionsMsg = "⚠️ No logramos reconocer ese estado.\n\nPor favor, responde con el *NÚMERO* o el *NOMBRE* de tu estado en esta lista:\n\n";
                if (availableStatesCache.length === 0) stateOptionsMsg = "⚠️ Lo siento, no hay estados.";
                else availableStatesCache.forEach((s, idx) => stateOptionsMsg += `[${idx + 1}] ${s.original}\n`);
                await sendMetaMessage(phone, stateOptionsMsg);
                return;
            }
            await updateUser(phone, { current_state: validState, step: 'asking_part' });
            await sendMetaMessage(phone, `¡Perfecto! Buscaremos en *${validState}*.\n\nDime qué refacción buscas.\n\n💡 _Para cambiar envía *ESTADO*_`);
        }
        else if (step === 'asking_part') {
            if (text.toUpperCase().trim() === 'FINALIZAR' && userCarts[phone] && userCarts[phone].length > 0) {
                if (user.client_name && user.client_number) await processOrder(phone, user.client_name, user.client_number, user.current_state);
                else {
                    await updateUser(phone, { step: 'asking_name' });
                    await sendMetaMessage(phone, "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?");
                }
                return;
            }

            const matchedState = getValidState(text);
            if (matchedState) {
                await updateUser(phone, { current_state: matchedState, step: 'asking_part' });
                user.current_state = matchedState;
                await sendMetaMessage(phone, `📍 Detecté que mencionaste el estado *${matchedState}*.\nHe actualizado tu zona de búsqueda a este estado.\n\nAhora sí, dime ¿qué refacción buscas?`);
                return;
            }

            if (text.length > 3) {
                const cleanText = text.trim();
                const { data: branchMatch } = await supabase.from('branches').select('name, state').ilike('name', `%${cleanText}%`).limit(1);
                if (branchMatch && branchMatch.length > 0) {
                    const matchedBranchState = branchMatch[0].state;
                    await updateUser(phone, { current_state: matchedBranchState, step: 'asking_part' });
                    user.current_state = matchedBranchState;
                    await sendMetaMessage(phone, `🏪 Detecté que mencionaste la sucursal *${branchMatch[0].name}* (*${matchedBranchState}*).\nHe actualizado tu zona.\n\nAhora sí, dime ¿qué refacción buscas?`);
                    return;
                }
            }

            const state = user.current_state;
            await sendMetaMessage(phone, "🔍 Buscando en nuestro inventario...");
            const results = await searchParts(text, state);
            
            if (results.length === 0) {
                await logAnalytics({ phone_number: phone, search_query: text, found: false, state: state });
                let fallbackMsg = `❌ Lo siento, no pudimos encontrar "${text}" en sucursales de ${state}.\n\nSimplemente escribe el nombre de otra pieza para buscar.`;
                if (userCarts[phone] && userCarts[phone].length > 0) fallbackMsg += `\n\n*(Opcional: Envía *FINALIZAR* para confirmar pedido, o *REINICIAR* para vaciar el carrito).*`;
                else fallbackMsg += `\n\n*(Opcional: Envía ESTADO para cambiar la zona, o *REINICIAR* para volver al menú).*`;
                await sendMetaMessage(phone, fallbackMsg);
            } else {
                await logAnalytics({ phone_number: phone, search_query: text, found: true, state: state });
                const cart = userCarts[phone] || [];
                let validItemsFound = 0;
                
                let optionsData = {};
                let optionCounter = 1;
                
                let sections = [{ title: "Resultados Disponibles", rows: [] }];
                
                let textBody = `✅ *Resultados encontrados en ${state}:*\n\n`;
                
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
                        if (actualStock > 0) branchesWithStock.push({ ...inv, stock: actualStock });
                    });
                    
                    if (branchesWithStock.length > 0) {
                        validItemsFound++;
                        textBody += `📦 *${item.part.part_number}* - ${item.part.description} ($${item.part.price})\n`;
                        branchesWithStock.forEach(inv => {
                            optionsData[optionCounter] = { part: item.part, branch: inv };
                            sections[0].rows.push({
                                id: optionCounter.toString(),
                                title: `${inv.branch_name} (${inv.stock})`,
                                description: `${item.part.part_number} - $${item.part.price}`
                            });
                            optionCounter++;
                        });
                    }
                });
                
                if (validItemsFound === 0) {
                    let alertMsg = `⚠️ La refacción "${text}" existe en ${state}, pero el inventario disponible ya lo tienes reservado en tu carrito actual.\n\nEscribe el nombre de otra pieza para seguir buscando.`;
                    if (userCarts[phone] && userCarts[phone].length > 0) alertMsg += `\n\n*(Opcional: Envía *FINALIZAR* para confirmar tu pedido).*`;
                    await sendMetaMessage(phone, alertMsg);
                } else {
                    sections[0].rows.push({ id: "OTRA", title: "Buscar otra pieza" });
                    if (cart.length > 0) sections[0].rows.push({ id: "FINALIZAR", title: "Finalizar pedido actual" });
                    sections[0].rows.push({ id: "REINICIAR", title: "Borrar carrito y reiniciar" });

                    userSearchSessions[phone] = optionsData;
                    await updateUser(phone, { step: 'choosing_branch' });
                    
                    // Asegurarse de no exceder el límite de 10 rows de WhatsApp
                    if(sections[0].rows.length > 10) {
                        sections[0].rows = sections[0].rows.slice(0, 10);
                    }
                    
                    await sendMetaMessage(phone, null, 'interactive', {
                        type: "list",
                        header: { type: "text", text: `🔎 Resultados de búsqueda` },
                        body: { text: textBody + "\nSelecciona una opción de la lista:" },
                        footer: { text: "Selecciona una sucursal" },
                        action: { button: "Ver Opciones", sections: sections }
                    });
                }
            }
        }
        else if (step === 'choosing_branch') {
            if (text.toUpperCase().trim() === 'FINALIZAR' && userCarts[phone] && userCarts[phone].length > 0) {
                delete userSearchSessions[phone];
                if (user.client_name && user.client_number) await processOrder(phone, user.client_name, user.client_number, user.current_state);
                else {
                    await updateUser(phone, { step: 'asking_name' });
                    await sendMetaMessage(phone, "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?");
                }
                return;
            }
            if (text.toUpperCase().trim() === 'OTRA' || text.toUpperCase().trim() === 'OTRO') {
                delete userSearchSessions[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* buscas:");
                return;
            }

            const optionIndex = parseInt(text);
            const sessionData = userSearchSessions[phone];
            
            if (sessionData && sessionData[optionIndex]) {
                const selection = sessionData[optionIndex];
                userPendingItems[phone] = { part: selection.part, branch: selection.branch };
                await updateUser(phone, { step: 'asking_quantity' });
                await sendMetaMessage(phone, "¿Cuántas piezas necesitas? (Ingresa solo el número)");
            } else {
                await sendMetaMessage(phone, "⚠️ Opción inválida.\n\n👉 Usa el botón de la lista o envía *REINICIAR*.");
            }
        }
        else if (step === 'asking_quantity') {
            if (text.toUpperCase().trim() === 'REGRESAR') {
                const sessionData = userSearchSessions[phone];
                if (!sessionData) {
                    await sendMetaMessage(phone, "⚠️ Tu búsqueda expiró. Por favor, escribe 'Reiniciar' e intenta de nuevo.");
                    return;
                }
                // Aquí en el futuro podríamos enviar la lista de nuevo
                await updateUser(phone, { step: 'choosing_branch' });
                delete userPendingItems[phone];
                await sendMetaMessage(phone, `✅ Regresando a opciones previas... Selecciona de la lista de arriba nuevamente o envía *REINICIAR*.`);
                return;
            }

            const quantity = parseInt(text);
            if (isNaN(quantity) || quantity <= 0) {
                await sendMetaMessage(phone, "⚠️ Por favor ingresa un número válido (ej. 1, 2, 3), o responde *REGRESAR* para ver las opciones.");
                return;
            }
            
            const pendingItem = userPendingItems[phone];
            if (!pendingItem) {
                await sendMetaMessage(phone, "⚠️ Hubo un error recuperando tu pieza. Por favor, escribe 'Reiniciar'.");
                return;
            }

            if (quantity > pendingItem.branch.stock) {
                await sendMetaMessage(phone, `⚠️ Lo sentimos, actualmente solo tenemos *${pendingItem.branch.stock}* pieza(s) disponible(s) en esta sucursal.\n\nPor favor ingresa una cantidad menor o igual a ${pendingItem.branch.stock}, o responde *REGRESAR*.`);
                return;
            }

            if (!userCarts[phone]) userCarts[phone] = [];
            userCarts[phone].push({ ...pendingItem, quantity });
            
            delete userPendingItems[phone];
            delete userSearchSessions[phone];
            
            await updateUser(phone, { step: 'asking_more' });
            
            // BOTONES INTERACTIVOS TOUCH
            await sendMetaMessage(phone, null, 'interactive', {
                type: "button",
                body: { text: `✅ ¡Pieza agregada a tu carrito! (Llevas ${userCarts[phone].length} artículo/s).\n\n¿Deseas agregar otra refacción a tu pedido?` },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "SI", title: "SÍ, Buscar Otra" } },
                        { type: "reply", reply: { id: "FINALIZAR", title: "FINALIZAR Pedido" } },
                        { type: "reply", reply: { id: "CANCELAR", title: "CANCELAR Todo" } }
                    ]
                }
            });
        }
        else if (step === 'asking_more') {
            const res = text.toUpperCase().trim();
            if (res === 'SI' || res === 'SÍ' || res === 'S') {
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* buscas:");
            } else if (res === 'NO' || res === 'N' || res === 'FINALIZAR') {
                if (user.client_name && user.client_number) {
                    await processOrder(phone, user.client_name, user.client_number, user.current_state);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    await sendMetaMessage(phone, "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?");
                }
            } else if (res === 'CANCELAR') {
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "🗑️ Carrito vaciado correctamente.\n\nDime qué refacción buscas ahora:");
            } else {
                await sendMetaMessage(phone, "⚠️ Por favor presiona uno de los botones o escribe SI, NO o CANCELAR.");
            }
        }
        else if (step === 'asking_name') {
            const clientName = text;
            await updateUser(phone, { client_name: clientName });
            await processOrder(phone, clientName, 'Nuevo Registro', user.current_state);
        }
    } catch (error) {
        console.error("Error procesando mensaje:", error);
    }
}

async function processOrder(phone, clientName, clientNumber, currentState) {
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

    await sendMetaMessage(phone, clientTicket);

    let cleanClientPhone = phone.replace('@c.us', '').replace('@lid', '').replace(/\+/g, '').trim();

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

        await sendMetaMessage(agentPhone, agentMsg);
    }

    for (const item of cart) {
        await logAnalytics({ phone_number: phone, search_query: item.part.part_number, found: true, ordered: true, branch_id: item.branch.branch_id, state: currentState });
        await deductInventory(item.branch.branch_id, item.part.part_number, item.quantity);
    }

    await updateUser(phone, { step: 'idle' });
    delete userCarts[phone];
}
