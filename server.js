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
    } finally {
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (err) {
                console.error("Error deleting temp inventory Excel file:", err);
            }
        }
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
    } finally {
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (err) {
                console.error("Error deleting temp branches Excel file:", err);
            }
        }
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
    } finally {
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (err) {
                console.error("Error deleting temp parts Excel file:", err);
            }
        }
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

// API: Descargar Excel de Ejemplo Dinámico
app.get('/api/download-sample-excel', (req, res) => {
    const type = req.query.type || 'inventory';
    let headers = [];
    let sampleData = [];
    let filename = '';

    if (type === 'inventory') {
        headers = ['Numero_Parte', 'Descripcion', 'Precio', 'ID_Sucursal', 'Stock'];
        sampleData = [
            {
                Numero_Parte: 'F-10023',
                Descripcion: 'Filtro de Aceite Premium',
                Precio: 185.50,
                ID_Sucursal: 1,
                Stock: 25
            },
            {
                Numero_Parte: 'B-20045',
                Descripcion: 'Balatas Delanteras Carbón',
                Precio: 450.00,
                ID_Sucursal: 1,
                Stock: 12
            },
            {
                Numero_Parte: 'F-10023',
                Descripcion: 'Filtro de Aceite Premium',
                Precio: 185.50,
                ID_Sucursal: 2,
                Stock: 15
            }
        ];
        filename = 'ejemplo_inventario.xlsx';
    } else if (type === 'branches') {
        headers = ['id', 'name', 'state', 'address', 'agent_phone', 'contact'];
        sampleData = [
            {
                id: 1,
                name: 'Sucursal Guadalajara Centro',
                state: 'Jalisco',
                address: 'Av. Juárez 150, Col. Centro',
                agent_phone: '5213312345678',
                contact: 'Ing. Carlos Mendoza'
            },
            {
                id: 2,
                name: 'Sucursal Monterrey Norte',
                state: 'Nuevo León',
                address: 'Av. Universidad 4500, Col. Anáhuac',
                agent_phone: '5218112345678',
                contact: 'Lic. Sofía Garza'
            }
        ];
        filename = 'ejemplo_sucursales.xlsx';
    } else if (type === 'parts') {
        headers = ['Numero_Parte', 'Descripcion', 'Precio'];
        sampleData = [
            {
                Numero_Parte: 'F-10023',
                Descripcion: 'Filtro de Aceite Premium',
                Precio: 185.50
            },
            {
                Numero_Parte: 'B-20045',
                Descripcion: 'Balatas Delanteras Carbón',
                Precio: 450.00
            },
            {
                Numero_Parte: 'B-30089',
                Descripcion: 'Bujía de Iridio NGK',
                Precio: 120.00
            }
        ];
        filename = 'ejemplo_refacciones.xlsx';
    }

    try {
        const worksheet = xlsx.utils.json_to_sheet(sampleData, { header: headers });
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Ejemplo');
        
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (error) {
        console.error('Error generando Excel de ejemplo:', error);
        res.status(500).send('Error al generar el archivo de ejemplo.');
    }
});

// API: Obtener Estado de Salud del Sistema (Health Check para Meta Cloud API)
app.get('/api/status', async (req, res) => {
    // 1. Verificar Supabase
    let supabaseStatus = 'disconnected';
    let supabaseDetails = 'No configurado';
    if (supabase) {
        try {
            const { data, error } = await supabase.from('branches').select('id').limit(1);
            if (error) {
                supabaseStatus = 'error';
                supabaseDetails = `Error de consulta: ${error.message}`;
            } else {
                supabaseStatus = 'connected';
                supabaseDetails = 'Base de datos en línea y conectada';
            }
        } catch (err) {
            supabaseStatus = 'error';
            supabaseDetails = `Fallo de conexión: ${err.message}`;
        }
    } else {
        supabaseStatus = 'missing_credentials';
        supabaseDetails = 'Faltan SUPABASE_URL o SUPABASE_KEY en .env';
    }

    // 2. Verificar OpenAI
    let openaiStatus = 'disconnected';
    let openaiDetails = 'No configurada';
    const openAIKey = process.env.OPENAI_API_KEY;
    if (openAIKey && openAIKey !== 'tu_openai_api_key_aqui' && openAIKey.trim() !== '') {
        if (openAIKey.startsWith('sk-')) {
            openaiStatus = 'configured';
            openaiDetails = 'API Key válida sintácticamente (comienza con sk-)';
        } else {
            openaiStatus = 'invalid_format';
            openaiDetails = 'Formato de API Key no válido (debe comenzar con sk-)';
        }
    } else {
        openaiStatus = 'missing_credentials';
        openaiDetails = 'Falta OPENAI_API_KEY o tiene el valor por defecto';
    }

    // 3. Verificar Meta Cloud API
    let metaStatus = 'disconnected';
    let metaDetails = 'No configurada';
    const metaToken = process.env.META_ACCESS_TOKEN;
    const metaPhoneId = process.env.META_PHONE_NUMBER_ID;
    const metaVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    const hasToken = metaToken && metaToken !== 'tu_token_de_acceso_temporal_aqui' && metaToken.trim() !== '';
    const hasPhoneId = metaPhoneId && metaPhoneId !== 'tu_phone_number_id_aqui' && metaPhoneId.trim() !== '';
    const hasVerify = metaVerifyToken && metaVerifyToken !== 'tu_webhook_verify_token_aqui' && metaVerifyToken.trim() !== '';

    if (hasToken && hasPhoneId && hasVerify) {
        metaStatus = 'configured';
        metaDetails = 'Webhook y credenciales de envío listas';
    } else {
        const missing = [];
        if (!hasToken) missing.push('META_ACCESS_TOKEN');
        if (!hasPhoneId) missing.push('META_PHONE_NUMBER_ID');
        if (!hasVerify) missing.push('META_WEBHOOK_VERIFY_TOKEN');
        metaStatus = 'incomplete';
        metaDetails = `Falta configurar: ${missing.join(', ')}`;
    }

    // 4. Estatus General
    let overallStatus = 'disconnected';
    if (supabaseStatus === 'connected' && openaiStatus === 'configured' && metaStatus === 'configured') {
        overallStatus = 'connected';
    } else if (supabaseStatus === 'connected' && (openaiStatus === 'configured' || metaStatus === 'configured')) {
        overallStatus = 'warning';
    } else {
        overallStatus = 'error';
    }

    res.json({
        status: overallStatus,
        services: {
            supabase: { status: supabaseStatus, details: supabaseDetails },
            openai: { status: openaiStatus, details: openaiDetails },
            meta: { status: metaStatus, details: metaDetails }
        }
    });
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
    let tempPath = null;
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
        
        tempPath = path.join(__dirname, `temp_${Date.now()}.ogg`);
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
        
        return transcription.text;
    } catch(e) {
        console.error("Error transcribing audio:", e.response?.data || e.message);
        return null;
    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (err) {
                console.error("Error deleting temp audio file:", err);
            }
        }
    }
}

// ==========================================
// 3. TEXT-TO-SPEECH (TTS) HELPERS
// ==========================================

function cleanTextForTTS(text) {
    if (!text) return "";
    return text
        .replace(/\*/g, '') // Quitar negritas *
        .replace(/_/g, '') // Quitar cursivas _
        .replace(/-{2,}/g, '') // Quitar divisores ----
        .replace(/▪/g, '') // Quitar viñetas de cuadrado
        .replace(/[-\*•]/g, '') // Quitar guiones y viñetas
        .replace(/wa\.me\/\d+/g, '') // Quitar enlaces wa.me
        .replace(/💡/g, '') // Quitar emojis específicos si interfieren
        .replace(/🚗/g, '')
        .replace(/🏪/g, '')
        .replace(/📍/g, '')
        .replace(/🔎/g, '')
        .replace(/📦/g, '')
        .replace(/✅/g, '')
        .replace(/⚠️/g, '')
        .replace(/❌/g, '')
        .replace(/🎉/g, '')
        .replace(/🔄/g, '')
        .replace(/⏱️/g, '')
        .replace(/🗑️/g, '')
        .replace(/🔔/g, '')
        .replace(/👉/g, '')
        .trim();
}

async function generateSpeechBuffer(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'tu_openai_api_key_aqui') {
        console.warn("⚠️ OpenAI API Key no configurada para TTS.");
        return null;
    }
    try {
        const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: text,
        });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        return buffer;
    } catch (error) {
        console.error("Error generando TTS con OpenAI:", error.message);
        return null;
    }
}

async function uploadAudioToWhatsApp(audioBuffer) {
    const token = process.env.META_ACCESS_TOKEN;
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    if (!token || !phoneId) {
        console.error("Faltan credenciales de Meta Cloud API para subir media.");
        return null;
    }

    try {
        const boundary = '----WhatsAppTTSBoundary' + Date.now().toString(16);
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
        const middle = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`;
        const footer = `--${boundary}--\r\n`;

        const payload = Buffer.concat([
            Buffer.from(header, 'utf-8'),
            audioBuffer,
            Buffer.from(middle + footer, 'utf-8')
        ]);

        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${phoneId}/media`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                }
            }
        );

        return response.data.id;
    } catch (error) {
        console.error("Error al subir audio a WhatsApp:", error.response?.data || error.message);
        return null;
    }
}

async function sendMetaVoiceNote(phone, text) {
    const cleanText = cleanTextForTTS(text);
    if (!cleanText) return;

    console.log(`🎙️ Generando nota de voz (TTS) para ${phone}: "${cleanText.substring(0, 50)}..."`);
    const audioBuffer = await generateSpeechBuffer(cleanText);
    if (!audioBuffer) return;

    const mediaId = await uploadAudioToWhatsApp(audioBuffer);
    if (!mediaId) return;

    let to = phone.replace('@c.us', '').replace('@lid', '').replace(/\+/g, '').trim();
    if (to.length === 10) to = '52' + to;

    const token = process.env.META_ACCESS_TOKEN;
    const phoneId = process.env.META_PHONE_NUMBER_ID;

    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${phoneId}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
                type: "audio",
                audio: {
                    id: mediaId
                }
            },
            {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            }
        );
        console.log(`🎙️ Nota de voz (TTS) enviada exitosamente a ${to}`);
    } catch (error) {
        console.error("Error sending audio message:", error.response?.data || error.message);
    }
}

async function sendStateOptionsList(phone, user, customText = null) {
    if (availableStatesCache.length === 0) {
        await sendMetaMessage(phone, "⚠️ Lo siento, no hay estados disponibles registrados en el sistema en este momento.");
        return;
    }

    let rows = availableStatesCache.map((s, idx) => ({
        id: s.original,
        title: s.original.substring(0, 24),
        description: `Ver catálogo de ${s.original}`
    }));

    if (rows.length > 10) rows = rows.slice(0, 10);

    let bodyText = customText;
    if (!bodyText) {
        if (user && user.client_name) {
            bodyText = `¡Bienvenido de nuevo, *${user.client_name}*! 🚗\n\n¿De qué *Estado de la República* nos contactas hoy?`;
        } else {
            bodyText = "¡Bienvenido al cotizador de refacciones! 🚗\n\n¿De qué *Estado de la República* nos contactas?";
        }
    }

    await sendMetaMessage(phone, null, 'interactive', {
        type: "list",
        header: { type: "text", text: `📍 Ubicación` },
        body: { text: bodyText },
        footer: { text: "Selecciona tu estado" },
        action: {
            button: "Ver Estados",
            sections: [{
                title: "Estados Disponibles",
                rows: rows
            }]
        }
    });

    // Enviar también nota de voz de bienvenida de forma asíncrona
    sendMetaVoiceNote(phone, bodyText).catch(e => console.error("Error en TTS asíncrono de Estados:", e));
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
        await sendStateOptionsList(phone, user, "Cambiando de estado... 📍\n¿En qué *Estado de la República* deseas hacer la consulta ahora?");
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
                sendMetaVoiceNote(phone, greeting).catch(e => console.error("TTS error:", e));
            } else {
                const detectedState = detectStateFromPhone(phone);
                if (detectedState) {
                    await updateUser(phone, { current_state: detectedState, step: 'asking_part' });
                    const msg = `¡Bienvenido al cotizador de refacciones! 🚗\n\nPor tu código de área veo que nos contactas desde *${detectedState}*.\n\nDime qué refacción buscas (audio o texto).\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona._`;
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                } else {
                    await updateUser(phone, { step: 'asking_state' });
                    await sendStateOptionsList(phone, user);
                }
            }
        } 
        else if (step === 'asking_state') {
            const validState = getValidState(text);
            if (!validState) {
                await sendStateOptionsList(phone, user, "⚠️ No logramos reconocer ese estado.\n\nPor favor, selecciona tu *Estado de la República* de la lista táctil:");
                return;
            }
            await updateUser(phone, { current_state: validState, step: 'asking_part' });
            const msg = `¡Perfecto! Buscaremos en *${validState}*.\n\nDime qué refacción buscas.`;
            await sendMetaMessage(phone, msg);
            sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
        }
        else if (step === 'asking_part') {
            if (text.toUpperCase().trim() === 'FINALIZAR' && userCarts[phone] && userCarts[phone].length > 0) {
                if (user.client_name && user.client_number) await processOrder(phone, user.client_name, user.client_number, user.current_state);
                else {
                    await updateUser(phone, { step: 'asking_name' });
                    const msg = "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?";
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                }
                return;
            }

            const matchedState = getValidState(text);
            if (matchedState) {
                await updateUser(phone, { current_state: matchedState, step: 'asking_part' });
                user.current_state = matchedState;
                const msg = `📍 Detecté que mencionaste el estado *${matchedState}*.\nHe actualizado tu zona de búsqueda a este estado.\n\nAhora sí, dime ¿qué refacción buscas?`;
                await sendMetaMessage(phone, msg);
                sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                return;
            }

            if (text.length > 3) {
                const cleanText = text.trim();
                const { data: branchMatch } = await supabase.from('branches').select('name, state').ilike('name', `%${cleanText}%`).limit(1);
                if (branchMatch && branchMatch.length > 0) {
                    const matchedBranchState = branchMatch[0].state;
                    await updateUser(phone, { current_state: matchedBranchState, step: 'asking_part' });
                    user.current_state = matchedBranchState;
                    const msg = `🏪 Detecté que mencionaste la sucursal *${branchMatch[0].name}* (*${matchedBranchState}*).\nHe actualizado tu zona.\n\nAhora sí, dime ¿qué refacción buscas?`;
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
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
                sendMetaVoiceNote(phone, fallbackMsg).catch(e => console.error("TTS error:", e));
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
                    sendMetaVoiceNote(phone, alertMsg).catch(e => console.error("TTS error:", e));
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
                    sendMetaVoiceNote(phone, `Hemos encontrado las siguientes opciones en sucursales de ${state}. Por favor presiona el botón Ver Opciones en pantalla para elegir tu sucursal.`).catch(e => console.error("TTS error:", e));
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
                sendMetaVoiceNote(phone, `¿Cuántas piezas necesitas de ${selection.part.description}? Por favor responde escribiendo solo el número.`).catch(e => console.error("TTS error:", e));
            } else {
                await sendMetaMessage(phone, "⚠️ Opción inválida.\n\n👉 Usa el botón de la lista o envía *REINICIAR*.");
                sendMetaVoiceNote(phone, "Opción inválida. Usa el botón de la lista en tu pantalla o envía REINICIAR.").catch(e => console.error("TTS error:", e));
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
                sendMetaVoiceNote(phone, "Por favor ingresa un número de piezas válido, o responde REGRESAR para ver las opciones de sucursales.").catch(e => console.error("TTS error:", e));
                return;
            }
            
            const pendingItem = userPendingItems[phone];
            if (!pendingItem) {
                await sendMetaMessage(phone, "⚠️ Hubo un error recuperando tu pieza. Por favor, escribe 'Reiniciar'.");
                return;
            }

            if (quantity > pendingItem.branch.stock) {
                const stockMsg = `⚠️ Lo sentimos, actualmente solo tenemos *${pendingItem.branch.stock}* pieza(s) disponible(s) en esta sucursal.\n\nPor favor ingresa una cantidad menor o igual a ${pendingItem.branch.stock}, o responde *REGRESAR*.`;
                await sendMetaMessage(phone, stockMsg);
                sendMetaVoiceNote(phone, `Lo sentimos, actualmente solo tenemos ${pendingItem.branch.stock} piezas disponibles en esta sucursal. Por favor ingresa una cantidad menor o igual, o responde REGRESAR.`).catch(e => console.error("TTS error:", e));
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
            sendMetaVoiceNote(phone, `¡Pieza agregada a tu carrito! Llevas ${userCarts[phone].length} artículo en tu pedido. ¿Deseas agregar otra refacción, finalizar el pedido o cancelar todo? Selecciona en tu pantalla.`).catch(e => console.error("TTS error:", e));
        }
        else if (step === 'asking_more') {
            const res = text.toUpperCase().trim();
            if (res === 'SI' || res === 'SÍ' || res === 'S') {
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* buscas:");
                sendMetaVoiceNote(phone, "Entendido. Dime qué otra refacción buscas:").catch(e => console.error("TTS error:", e));
            } else if (res === 'NO' || res === 'N' || res === 'FINALIZAR') {
                if (user.client_name && user.client_number) {
                    await processOrder(phone, user.client_name, user.client_number, user.current_state);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    const msg = "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?";
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                }
            } else if (res === 'CANCELAR') {
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                const msg = "🗑️ Carrito vaciado correctamente.\n\nDime qué refacción buscas ahora:";
                await sendMetaMessage(phone, msg);
                sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
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
    sendMetaVoiceNote(phone, "¡Excelente! Tu pedido ha sido confirmado con éxito. Hemos enviado el resumen a tu WhatsApp y en breve nuestros agentes de ventas se comunicarán contigo para coordinar el pago y la entrega. ¡Muchas gracias por tu compra!").catch(e => console.error("TTS error:", e));

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
