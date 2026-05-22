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
const openAIKey = process.env.OPENAI_API_KEY;
let openai = null;
if (openAIKey && openAIKey !== 'tu_openai_api_key_aqui' && openAIKey.trim() !== '') {
    openai = new OpenAI({
        apiKey: openAIKey
    });
} else {
    console.warn("⚠️ Advertencia: OpenAI API Key no configurada o es inválida. Las funciones de IA y TTS estarán desactivadas.");
}

// Cache temporal
const userSearchSessions = {};
const userCarts = {};
const userPendingItems = {};
const userLastActive = {}; 
const userVins = {};

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
        if (states && states.length > 0) {
            // Sort states alphabetically for consistent and complete display
            states.sort((a, b) => a.localeCompare(b));
            availableStatesCache = states.map(s => ({
                original: s,
                normalized: normalizeString(s)
            }));
        }
    } catch (e) {
        console.error("Error refrescando estados:", e);
    }
}
refreshAvailableStates();
setInterval(refreshAvailableStates, 3600000);

function normalizeString(str) {
    return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// ==========================================
// 2.5. PARSERS PARA ENTRADAS DE VOZ (STT) Y TEXTO HABLADO
// ==========================================
function parseSpokenNumber(text) {
    if (!text) return NaN;
    const clean = text.toLowerCase().trim();
    
    const wordToNumber = {
        'cero': 0, 'uno': 1, 'una': 1, 'primer': 1, 'primero': 1, 'primera': 1,
        'dos': 2, 'segundo': 2, 'segunda': 2,
        'tres': 3, 'tercer': 3, 'tercero': 3, 'tercera': 3,
        'cuatro': 4, 'cuarto': 4, 'cuarta': 4,
        'cinco': 5, 'quinto': 5, 'quinta': 5,
        'seis': 6, 'sexto': 6, 'sexta': 6,
        'siete': 7, 'septimo': 7, 'séptimo': 7, 'septima': 7, 'séptima': 7,
        'ocho': 8, 'octavo': 8, 'octava': 8,
        'nueve': 9, 'noveno': 9, 'novena': 9,
        'diez': 10, 'decimo': 10, 'décimo': 10, 'decima': 10, 'décima': 10
    };
    
    const matchDigits = clean.match(/\b\d+\b/);
    if (matchDigits) {
        return parseInt(matchDigits[0]);
    }
    
    const words = clean.split(/\s+/);
    for (const word of words) {
        const cleanWord = word.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        if (wordToNumber[cleanWord] !== undefined) {
            return wordToNumber[cleanWord];
        }
    }
    
    return NaN;
}

function parseMultipleNumbers(text) {
    if (!text) return [];
    const clean = text.toLowerCase().trim();
    
    const wordToNumber = {
        'cero': 0, 'uno': 1, 'una': 1, 'primer': 1, 'primero': 1, 'primera': 1,
        'dos': 2, 'segundo': 2, 'segunda': 2,
        'tres': 3, 'tercer': 3, 'tercero': 3, 'tercera': 3,
        'cuatro': 4, 'cuarto': 4, 'cuarta': 4,
        'cinco': 5, 'quinto': 5, 'quinta': 5,
        'seis': 6, 'sexto': 6, 'sexta': 6,
        'siete': 7, 'septimo': 7, 'séptimo': 7, 'septima': 7, 'séptima': 7,
        'ocho': 8, 'octavo': 8, 'octava': 8,
        'nueve': 9, 'noveno': 9, 'novena': 9,
        'diez': 10, 'decimo': 10, 'décimo': 10, 'decima': 10, 'décima': 10
    };

    // Primero, busquemos todos los grupos de dígitos en el texto
    const digitMatches = clean.match(/\d+/g);
    if (digitMatches && digitMatches.length > 0) {
        return Array.from(new Set(digitMatches.map(num => parseInt(num))));
    }
    
    // Si no hay dígitos literales, dividimos por espacios, comas o "y"
    const tokens = clean.split(/[\s,y]+/).filter(t => t.length > 0);
    const results = [];
    for (const token of tokens) {
        const cleanWord = token.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        if (wordToNumber[cleanWord] !== undefined) {
            results.push(wordToNumber[cleanWord]);
        }
    }
    return Array.from(new Set(results));
}

function parseSpokenIntent(text) {
    if (!text) return null;
    const clean = text.toLowerCase().trim();
    
    const yesPatterns = [
        /\bsi\b/i, /\bsí\b/i, /\bclaro\b/i, /\bagregar\b/i, /\botra\b/i, /\botro\b/i, 
        /\bmas\b/i, /\bmás\b/i, /\baceptar\b/i, /\bde acuerdo\b/i, /\bpor favor\b/i
    ];
    
    const noPatterns = [
        /\bno\b/i, /\bterminar\b/i, /\bfinalizar\b/i, /\bya no\b/i, /\bninguno\b/i, 
        /\bsuficiente\b/i, /\basí está bien\b/i, /\basi esta bien\b/i, /\bno gracias\b/i
    ];
    
    const cancelPatterns = [
        /\bcancelar\b/i, /\bvaciar\b/i, /\bborrar\b/i, /\breiniciar\b/i, /\beliminar\b/i
    ];

    for (const pattern of cancelPatterns) {
        if (pattern.test(clean)) return 'CANCELAR';
    }
    
    for (const pattern of noPatterns) {
        if (pattern.test(clean)) return 'FINALIZAR';
    }
    
    for (const pattern of yesPatterns) {
        if (pattern.test(clean)) return 'SI';
    }
    
    return null;
}

function getValidState(input, allowIndex = false) {
    const inputClean = input.trim();
    if (allowIndex) {
        const idx = parseInt(inputClean);
        if (!isNaN(idx) && idx > 0 && idx <= availableStatesCache.length) {
            return availableStatesCache[idx - 1].original;
        }
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

// ==========================================
// FUNCIÓN: DETECTAR VIN O NÚMERO DE MOTOR
// ==========================================
function extractVINAndPart(text) {
    // Detectar VIN (17 caracteres alfanuméricos, sin espacios ni guiones)
    const vinMatch = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
    const vin = vinMatch ? vinMatch[0].toUpperCase() : null;
    
    // Detectar número de motor (5-10 dígitos consecutivos o patron común)
    const motorMatch = text.match(/(?:motor|motor:\s*|motor #\s*)([0-9A-Z]{5,10})/i) || 
                       text.match(/\b[0-9]{5,10}\b/);
    const motor = motorMatch ? motorMatch[motorMatch.length - 1] : null;
    
    // Extraer la pieza buscada (remover VIN/Motor del texto)
    let partText = text;
    if (vin) partText = partText.replace(vin, '').trim();
    if (motor) partText = partText.replace(motor, '').trim();
    
    return {
        vin,
        motor,
        partDescription: partText.length > 0 ? partText : null
    };
}

function detectVinOrMotor(text) {
    if (!text) return null;
    
    // 1. Buscar VIN estándar de 17 caracteres en el texto original (con límites de palabra o espacio)
    const standardVinMatch = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
    if (standardVinMatch) return standardVinMatch[0].toUpperCase();

    // 2. Buscar series de motor Caterpillar (prefijo de 3 alfanuméricos + 5 dígitos, ej: 2WS12345, 6NZ04123)
    const catMotorMatch = text.match(/\b([A-Z0-9]{3}\d{5})\b/i);
    if (catMotorMatch) return catMotorMatch[1].toUpperCase();

    // 3. Buscar número de serie Cummins de 8 dígitos
    const cumminsMotorMatch = text.match(/\b(\d{8})\b/);
    if (cumminsMotorMatch) return cumminsMotorMatch[1];

    // 4. Buscar número de motor genérico (5-10 dígitos de forma explícita)
    const genericMotorMatch = text.match(/(?:motor|motor:\s*|motor #\s*)([0-9A-Z]{5,10})/i) || 
                              text.match(/\b\d{5,10}\b/);
    if (genericMotorMatch) return genericMotorMatch[genericMotorMatch.length - 1].toUpperCase();

    // 5. Si el texto original tiene espacios, podemos limpiarlo y buscar un VIN/Motor de 8-17 caracteres que contenga números y letras mezclados
    // (pero evitando palabras puramente alfabéticas como "FILTRODEACEITE")
    const squished = text.replace(/[-\s]/g, '').toUpperCase();
    const hybridMatch = squished.match(/[A-Z0-9]{8,17}/);
    if (hybridMatch) {
        const potential = hybridMatch[0];
        const hasDigits = /\d/.test(potential);
        const hasLetters = /[A-Z]/.test(potential);
        if (hasDigits && (potential.length >= 17 || hasLetters)) {
            return potential;
        }
    }

    return null;
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
    if (to.startsWith('521') && to.length === 13) {
        to = '52' + to.substring(3);
    }
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

async function sendOrderSummaryTicket(phone, user) {
    const cart = userCarts[phone] || [];
    if (cart.length === 0) {
        await updateUser(phone, { step: 'asking_part' });
        await sendMetaMessage(phone, "🛒 Tu carrito está vacío. Dime qué refacción deseas buscar:");
        return;
    }
    
    let ticket = `🛒 *RESUMEN DE TU PEDIDO* 🛒\n`;
    ticket += `--------------------------------\n`;
    let grandTotal = 0;
    
    cart.forEach((item, index) => {
        const price = item.part.price ? parseFloat(item.part.price) : 0;
        const totalItem = price * item.quantity;
        grandTotal += totalItem;
        ticket += `*${index + 1}.* ▪ *${item.quantity}x* ${item.part.description} (${item.part.part_number})\n`;
        ticket += `   Precio: $${price.toFixed(2)} MXN | Total: *$${totalItem.toFixed(2)} MXN*\n`;
        ticket += `   Sucursal: _${item.branch.branch_name}_\n\n`;
    });
    
    ticket += `--------------------------------\n`;
    ticket += `*Total a Pagar:* *$${grandTotal.toFixed(2)} MXN* _(IVA incluido)_\n\n`;
    ticket += `👤 *Facturar a:* ${user.client_name}\n`;
    ticket += `🔑 *No. Cliente:* ${user.client_number || 'Nuevo Registro'}\n`;
    ticket += `📍 *Zona de Búsqueda:* ${user.current_state || 'Nacional'}\n`;
    ticket += `--------------------------------\n`;
    ticket += `¿Deseas confirmar tu pedido para enviarlo al vendedor o deseas realizar cambios?`;
    
    await sendMetaMessage(phone, null, 'interactive', {
        type: "button",
        body: { text: ticket },
        action: {
            buttons: [
                { type: "reply", reply: { id: "CONFIRMAR_PEDIDO", title: "Confirmar Pedido [C]" } },
                { type: "reply", reply: { id: "MODIFICAR_CARRITO", title: "Modificar [M]" } },
                { type: "reply", reply: { id: "SEGUIR_COMPRANDO", title: "Seguir Comprando [O]" } }
            ]
        }
    });
    sendMetaVoiceNote(phone, `Aquí tienes el resumen de tu pedido por un total de ${grandTotal.toFixed(2)} pesos a nombre de ${user.client_name}. Por favor presiona Confirmar Pedido en pantalla para enviarlo a nuestros agentes de ventas, o presiona Modificar si deseas cambiar cantidades.`).catch(e => console.error("TTS error:", e));
}

// Helper: Transcribir Audio con OpenAI Whisper
async function transcribeAudio(audioId) {
    if (!openai) {
        console.warn("⚠️ Intento de transcripción sin cliente de OpenAI configurado.");
        return null;
    }
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

// Helper: Ejecutar búsqueda híbrida de VIN/refacción en Python
function runVinSearch(queryText) {
    return new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        
        // List of python executables to try in order
        const candidates = process.platform === 'win32' 
            ? ['py', 'python', 'python3'] 
            : ['python3', 'python', 'py'];
            
        let index = 0;
        let lastError = null;
        let accumulatedStderr = '';

        function tryNext() {
            if (index >= candidates.length) {
                return reject(new Error(`Python execution failed: All candidates [${candidates.join(', ')}] failed. Last error: ${lastError?.message}. Stderr: ${accumulatedStderr}`));
            }

            const cmd = candidates[index];
            console.log(`[AYUDA] Intentando ejecutar Python con comando: "${cmd}" para consulta: "${queryText}"`);
            
            execFile(cmd, ['vin_search.py', queryText], { encoding: 'utf8' }, (error, stdout, stderr) => {
                if (stderr) {
                    accumulatedStderr += `[${cmd} stderr]: ${stderr}\n`;
                }
                if (error) {
                    lastError = error;
                    index++;
                    tryNext();
                } else {
                    resolve(stdout);
                }
            });
        }

        tryNext();
    });
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
    if (!openai || !apiKey || apiKey === 'tu_openai_api_key_aqui') {
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
    // Desactivado a petición del usuario: el bot interpreta audios entrantes pero responde únicamente por texto
    return;
}

async function sendStateOptionsList(phone, user, customText = null) {
    if (availableStatesCache.length === 0) {
        await refreshAvailableStates();
    }
    if (availableStatesCache.length === 0) {
        await sendMetaMessage(phone, "⚠️ Lo siento, no hay estados disponibles registrados en el sistema en este momento.");
        return;
    }

    let bodyText = customText;
    if (!bodyText) {
        if (user && user.client_name) {
            if (user.client_number && user.client_number !== 'Nuevo Registro') {
                bodyText = `¡Bienvenido de nuevo, *${user.client_name}*! (Cliente No. *${user.client_number}*) 🚗\n\n¿De qué *Estado de la República* nos contactas hoy?`;
            } else {
                bodyText = `¡Bienvenido de nuevo, *${user.client_name}*! 🚗\n\n¿De qué *Estado de la República* nos contactas hoy?`;
            }
        } else {
            bodyText = "¡Bienvenido al cotizador de refacciones! 🚗\n\n¿De qué *Estado de la República* nos contactas?";
        }
    }

    if (availableStatesCache.length <= 10) {
        let rows = availableStatesCache.map((s, idx) => ({
            id: s.original,
            title: s.original.substring(0, 24),
            description: `Ver catálogo de ${s.original}`
        }));

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
    } else {
        // Generar un listado de texto numerado completo y elegante
        let stateMsg = `${bodyText}\n\n`;
        stateMsg += `📍 *Estados Disponibles:*\n`;
        availableStatesCache.forEach((s, idx) => {
            stateMsg += `*${idx + 1}.* ${s.original}\n`;
        });
        stateMsg += `\n👉 Escribe el *nombre* de tu estado o el *número* correspondiente para seleccionarlo:`;

        await sendMetaMessage(phone, stateMsg);
    }

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
    
    // Ensure states cache is populated
    if (availableStatesCache.length === 0) {
        await refreshAvailableStates();
    }
    
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
        delete userVins[phone];
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
        delete userVins[phone];
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

    if (lowerText.includes('ayuda') || lowerText.includes('help') || lowerText === '?' || lowerText === 'ayuda') {
        if (text.toUpperCase().trim() === 'AYUDA') {
            await updateUser(phone, { step: 'asking_help_details' });
            delete userSearchSessions[phone];
            delete userPendingItems[phone];
            
            const savedVin = userVins[phone];
            if (savedVin) {
                const explanation = `Veo que ya registramos el **Identificador (VIN/Serie de Motor): \`${savedVin}\`** en tu sesión. 🚗\n\nSolo escribe la **pieza** que buscas (ej. "filtro de aceite") y la buscaremos para ese mismo vehículo.\n\nSi deseas buscar para un vehículo diferente, ingresa el nuevo **VIN o Serie de Motor** y la pieza.`;
                await sendMetaMessage(phone, explanation);
                sendMetaVoiceNote(phone, cleanTextForTTS(explanation)).catch(e => console.error("TTS error:", e));
            } else {
                const explanation = `Para ayudarte a encontrar el número de parte exacto que necesitas, por favor envíanos:\n\n1. El **VIN (17 caracteres)** o el **Número de Serie de Motor** de tu vehículo.\n2. La **descripción clara de la pieza** que estás buscando.\n\n*(Ejemplo: "foco de reversa de 3VW3B7AN1H0000000" o "anillos para motor 2WS12345")*`;
                await sendMetaMessage(phone, explanation);
                sendMetaVoiceNote(phone, cleanTextForTTS(explanation)).catch(e => console.error("TTS error:", e));
            }
        } else {
            await updateUser(phone, { step: 'asking_help_menu_choice' });
            const helpMsg = `📞 *¡Bienvenido a nuestro Servicio de Ayuda!* 📞\n\n*¿Cómo te podemos ayudar?*\n\n1️⃣ *Buscar una Refacción:* Escribe el nombre de la pieza que necesitas (ej: "Filtro de aceite")\n\n2️⃣ *Cambiar de Estado:* Escribe *ESTADO* para cambiar tu zona de búsqueda\n\n3️⃣ *Ver Sucursales:* Escribe *SUCURSALES* para ver nuestro directorio completo\n\n4️⃣ *Mi Carrito:* Escribe *FINALIZAR* para completar tu pedido o *VACIAR* para limpiar el carrito\n\n5️⃣ *Contacto Directo:* Si tienes una pregunta específica, aquí estamos para ayudarte 🤝\n\n💡 *Consejo:* Puedes escribir en voz o texto. Nuestro sistema entiende audios, números de VIN y descripciones de piezas.\n\n¿En qué te podemos asistir hoy?`;
            await sendMetaMessage(phone, helpMsg);
            sendMetaVoiceNote(phone, `Bienvenido al servicio de ayuda. Puedes buscar una refacción, cambiar de estado, ver nuestras sucursales, o completar tu pedido. ¿En qué puedo ayudarte?`).catch(e => console.error("TTS error:", e));
        }
        return;
    }

    try {
        if (step === 'idle') {
            let greeting = `¡Bienvenido al cotizador de refacciones! 🚗`;
            if (user.client_name) {
                if (user.client_number && user.client_number !== 'Nuevo Registro') {
                    greeting = `¡Bienvenido de nuevo, *${user.client_name}*! (Cliente No. *${user.client_number}*) 🚗`;
                } else {
                    greeting = `¡Bienvenido de nuevo, *${user.client_name}*! 🚗`;
                }
            }

            if (user.current_state) {
                await updateUser(phone, { step: 'asking_part' });
                greeting += `\n\nRealizaré las búsquedas en tu estado preferido: *${user.current_state}*.\n\nSi ya conoces el número de parte de la refacción que estás buscando, envíame un mensaje de voz o texto con la información.\n\nSi aun no estás seguro del número de parte que necesitas, escribe *AYUDA* y te apoyamos.\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona, o *SUCURSALES* para ver nuestro directorio._`;
                await sendMetaMessage(phone, greeting);
                sendMetaVoiceNote(phone, greeting).catch(e => console.error("TTS error:", e));
            } else {
                const detectedState = detectStateFromPhone(phone);
                if (detectedState) {
                    await updateUser(phone, { current_state: detectedState, step: 'asking_part' });
                    const msg = `${greeting}\n\nPor tu código de área veo que nos contactas desde *${detectedState}*.\n\nSi ya conoces el número de parte de la refacción que estás buscando, envíame un mensaje de voz o texto con la información.\n\nSi aun no estás seguro del número de parte que necesitas, escribe *AYUDA* y te apoyamos.\n\n💡 _Menú rápido: Escribe *ESTADO* para cambiar de zona._`;
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                } else {
                    await updateUser(phone, { step: 'asking_state' });
                    await sendStateOptionsList(phone, user);
                }
            }
        } 
        else if (step === 'asking_state') {
            const validState = getValidState(text, true);
            if (!validState) {
                await sendStateOptionsList(phone, user, "⚠️ No logramos reconocer ese estado.\n\nPor favor, selecciona tu *Estado de la República* de la lista táctil:");
                return;
            }
            await updateUser(phone, { current_state: validState, step: 'asking_part' });
            const msg = `¡Perfecto! Buscaremos en *${validState}*.\n\nDime qué refacción buscas.`;
            await sendMetaMessage(phone, msg);
            sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
        }
        else if (step === 'asking_help_menu_choice') {
            const cleanText = text.trim();
            const choice = cleanText.toLowerCase();

            if (choice === '1' || choice.includes('buscar') || choice.includes('refaccion') || choice.includes('refacción')) {
                await updateUser(phone, { step: 'asking_help_details' });
                delete userSearchSessions[phone];
                delete userPendingItems[phone];
                
                const savedVin = userVins[phone];
                if (savedVin) {
                    const explanation = `Veo que ya registramos el **Identificador (VIN/Serie de Motor): \`${savedVin}\`** en tu sesión. 🚗\n\nSolo escribe la **pieza** que buscas (ej. "filtro de aceite") y la buscaremos para ese mismo vehículo.\n\nSi deseas buscar para un vehículo diferente, ingresa el nuevo **VIN o Serie de Motor** y la pieza.`;
                    await sendMetaMessage(phone, explanation);
                    sendMetaVoiceNote(phone, cleanTextForTTS(explanation)).catch(e => console.error("TTS error:", e));
                } else {
                    const explanation = `Para ayudarte a encontrar el número de parte exacto que necesitas, por favor envíanos:\n\n1. El **VIN (17 caracteres)** o el **Número de Serie de Motor** de tu vehículo.\n2. La **descripción clara de la pieza** que estás buscando.\n\n*(Ejemplo: "foco de reversa de 3VW3B7AN1H0000000" o "anillos para motor 2WS12345")*`;
                    await sendMetaMessage(phone, explanation);
                    sendMetaVoiceNote(phone, cleanTextForTTS(explanation)).catch(e => console.error("TTS error:", e));
                }
                return;
            }
            else if (choice === '2' || choice === 'estado' || choice.includes('cambiar')) {
                await updateUser(phone, { step: 'asking_state', current_state: null });
                await sendStateOptionsList(phone, user, "Cambiando de estado... 📍\n¿En qué *Estado de la República* deseas hacer la consulta ahora?");
                return;
            }
            else if (choice === '3' || choice === 'sucursales' || choice.includes('sucursal') || choice.includes('directorio')) {
                const branchesInfo = await getBranchesDirectory(user.current_state);
                await sendMetaMessage(phone, branchesInfo);
                await updateUser(phone, { step: 'asking_part' });
                return;
            }
            else if (choice === '4' || choice === 'finalizar' || choice === 'vaciar' || choice.includes('carrito') || choice.includes('pedido')) {
                const cart = userCarts[phone] || [];
                if (cart.length === 0) {
                    await sendMetaMessage(phone, "🛒 Tu carrito está vacío actualmente.\n\nEscribe el nombre de la pieza que buscas para empezar a agregar artículos.");
                    await updateUser(phone, { step: 'asking_part' });
                } else {
                    let summary = "🛒 *Tu Carrito Actual:*\n\n";
                    cart.forEach((item, idx) => {
                        summary += `*${idx + 1}.* ${item.part.part_number} - ${item.part.description} (${item.quantity} pza(s) en sucursal ${item.branch.branch_name}) - $${item.part.price * item.quantity}\n`;
                    });
                    summary += `\n👉 Escribe *FINALIZAR* para completar tu pedido.\n👉 Escribe *VACIAR* para limpiar el carrito.`;
                    await sendMetaMessage(phone, summary);
                    await updateUser(phone, { step: 'asking_part' });
                }
                return;
            }
            else if (choice === '5' || choice.includes('contacto') || choice.includes('pregunta') || choice.includes('asesor') || choice.includes('ejecutivo')) {
                await updateUser(phone, { step: 'asking_part' });
                const contactMsg = `📞 *Contacto Directo* 🤝\n\nSi tienes una pregunta específica o necesitas asistencia de un ejecutivo, por favor escribe tu mensaje aquí y un asesor se comunicará contigo a la brevedad.\n\nTambién puedes llamarnos al Centro de Atención Telefónica para asistencia inmediata.`;
                await sendMetaMessage(phone, contactMsg);
                sendMetaVoiceNote(phone, cleanTextForTTS(contactMsg)).catch(e => console.error("TTS error:", e));
                return;
            }
            else {
                await updateUser(phone, { step: 'asking_part' });
                await processMessageLogic(phone, text, senderName);
                return;
            }
        }
        else if (step === 'asking_part') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();

            if ((normalizedText === 'FINALIZAR' || normalizedText === 'F') && userCarts[phone] && userCarts[phone].length > 0) {
                if (user.client_name) {
                    await updateUser(phone, { step: 'confirming_order' });
                    const updatedUser = await getUser(phone);
                    await sendOrderSummaryTicket(phone, updatedUser);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    const msg = "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?";
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                }
                return;
            }

            if (normalizedText === 'REINICIAR' || normalizedText === 'V') {
                delete userSearchSessions[phone];
                delete userCarts[phone];
                delete userVins[phone];
                const msg = "🔄 *Conversación reiniciada*. Dime qué refacción buscas:";
                await sendMetaMessage(phone, msg);
                sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                return;
            }

            const matchedState = getValidState(text, false);
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

            // ✅ NUEVA LÓGICA: DETECTAR Y CONFIRMAR VIN O NÚMERO DE MOTOR
            const vinData = extractVINAndPart(text);
            if (vinData.vin || vinData.motor) {
                let vinConfirmMsg = "📌 *He detectado los siguientes datos:*\n\n";
                
                if (vinData.vin) {
                    vinConfirmMsg += `🔑 *VIN:* \`${vinData.vin}\`\n`;
                }
                if (vinData.motor) {
                    vinConfirmMsg += `⚙️ *Número de Motor:* \`${vinData.motor}\`\n`;
                }
                
                if (vinData.partDescription) {
                    vinConfirmMsg += `🔧 *Refacción buscada:* ${vinData.partDescription}\n`;
                } else {
                    vinConfirmMsg += `⚠️ *No detecté la refacción que buscas.*\n`;
                }
                
                vinConfirmMsg += `\n¿Es correcto esta información? Responde SÍ para continuar o NO para corregir.`;
                
                // Guardar datos temporales
                userPendingItems[phone] = {
                    vin: vinData.vin,
                    motor: vinData.motor,
                    partText: vinData.partDescription || text,
                    originalText: text
                };
                
                await updateUser(phone, { step: 'confirming_vin' });
                await sendMetaMessage(phone, vinConfirmMsg);
                sendMetaVoiceNote(phone, vinConfirmMsg).catch(e => console.error("TTS error:", e));
                return;
            }

            const state = user.current_state;
            await sendMetaMessage(phone, "🔍 Buscando en nuestro inventario...");
            const results = await searchParts(text, state);
            
            if (results.length === 0) {
                // Hacer búsqueda global (nacional)
                const globalResults = await searchParts(text, null);
                if (globalResults.length > 0) {
                    userSearchSessions[phone] = { type: 'foreign_pending', query: text, results: globalResults };
                    await updateUser(phone, { step: 'asking_foreign' });
                    
                    const msg = `💡 No encontramos "${text}" en sucursales de *${state}*.\n\nSin embargo, detectamos que la pieza *sí está disponible* en sucursales foráneas (de otros estados).\n\n¿Deseas que te mostremos las opciones disponibles de otros estados para solicitarla de allá?`;
                    
                    await sendMetaMessage(phone, null, 'interactive', {
                        type: "button",
                        body: { text: msg },
                        action: {
                            buttons: [
                                { type: "reply", reply: { id: "VER_FORANEAS", title: "SÍ, Ver Foráneas" } },
                                { type: "reply", reply: { id: "BUSCAR_OTRA", title: "NO, Buscar Otra" } }
                            ]
                        }
                    });
                    
                    sendMetaVoiceNote(phone, `No encontramos la refacción en sucursales de tu estado, pero sí está disponible en sucursales de otros estados. ¿Deseas ver las opciones foráneas? Selecciona sí o no en tu pantalla.`).catch(e => console.error("TTS error:", e));
                    return;
                }
                
                await logAnalytics({ phone_number: phone, search_query: text, found: false, state: state });
                let fallbackMsg = `❌ Lo siento, no pudimos encontrar "${text}" en sucursales de ${state}.\n\nSimplemente escribe el nombre de otra pieza para buscar.`;
                if (userCarts[phone] && userCarts[phone].length > 0) fallbackMsg += `\n\n*(Opcional: Envía *[F]* para confirmar pedido, o *[V]* para vaciar el carrito).*`;
                else fallbackMsg += `\n\n*(Opcional: Envía ESTADO para cambiar la zona, o *[V]* para volver al menú).*`;
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
                            const maxBranches = cart.length > 0 ? 7 : 8;
                            if (optionCounter <= maxBranches) {
                                optionsData[optionCounter] = { part: item.part, branch: inv };
                                textBody += `   👉 *[${optionCounter}]* ${inv.branch_name} (Stock: ${inv.stock})\n`;
                                sections[0].rows.push({
                                    id: optionCounter.toString(),
                                    title: `[${optionCounter}] ${inv.branch_name}`.substring(0, 24).trim(),
                                    description: `Stock: ${inv.stock} | ${item.part.description} ($${item.part.price})`.substring(0, 72)
                                });
                                optionCounter++;
                            }
                        });
                        textBody += `\n`;
                    }
                });
                
                if (validItemsFound === 0) {
                    let alertMsg = `⚠️ La refacción "${text}" existe en ${state}, pero el inventario disponible ya lo tienes reservado en tu carrito actual.\n\nEscribe el nombre de otra pieza para seguir buscando.`;
                    if (userCarts[phone] && userCarts[phone].length > 0) alertMsg += `\n\n*(Opcional: Envía *[F]* para confirmar tu pedido).*`;
                    await sendMetaMessage(phone, alertMsg);
                    sendMetaVoiceNote(phone, alertMsg).catch(e => console.error("TTS error:", e));
                } else {
                    sections[0].rows.push({ id: "O", title: "[O] Buscar otra pieza", description: "Buscar una refacción diferente" });
                    if (cart.length > 0) sections[0].rows.push({ id: "F", title: "[F] Finalizar pedido", description: "Confirmar y procesar tu pedido actual" });
                    sections[0].rows.push({ id: "V", title: "[V] Vaciar y reiniciar", description: "Borrar el carrito y comenzar de nuevo" });

                    // Asegurarse de no exceder el límite de 10 rows de WhatsApp
                    if(sections[0].rows.length > 10) {
                        sections[0].rows = sections[0].rows.slice(0, 10);
                    }
                    
                    let optionsText = `------------------\n`;
                    optionsText += `👉 *[O]* Buscar otra pieza\n`;
                    if (cart.length > 0) {
                        optionsText += `👉 *[F]* Finalizar pedido\n`;
                    }
                    optionsText += `👉 *[V]* Vaciar y reiniciar\n\n`;
                    
                    const listBodyText = textBody + optionsText + "Selecciona de la lista táctil o escribe el número correspondiente para proceder con tu compra. ¡Puedes elegir varios números a la vez separados por comas o la letra 'y' (ej. 1, 3 o 1 y 2)!";
                    const interactivePayload = {
                        type: "list",
                        header: { type: "text", text: `🔎 Resultados de búsqueda` },
                        body: { text: listBodyText },
                        footer: { text: "Selecciona una sucursal" },
                        action: { button: "Ver Opciones", sections: sections }
                    };

                    userSearchSessions[phone] = {
                        optionsData: optionsData,
                        interactivePayload: interactivePayload
                    };
                    await updateUser(phone, { step: 'choosing_branch' });
                    
                    await sendMetaMessage(phone, null, 'interactive', interactivePayload);
                    sendMetaVoiceNote(phone, `Hemos encontrado las siguientes opciones en sucursales de ${state}. Por favor presiona el botón Ver Opciones en pantalla para elegir tu sucursal.`).catch(e => console.error("TTS error:", e));
                }
            }
        }
        else if (step === 'asking_help_details') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();

            if (normalizedText === 'REINICIAR' || normalizedText === 'V') {
                delete userSearchSessions[phone];
                delete userCarts[phone];
                delete userVins[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "🔄 *Conversación reiniciada*. Dime qué refacción buscas:");
                return;
            }
            if (normalizedText === 'REGRESAR' || normalizedText === 'R') {
                await updateUser(phone, { step: 'idle' });
                await processMessageLogic(phone, "hola", user.client_name || senderName);
                return;
            }

            // Detectar si el texto entrante ya contiene un VIN o número de serie de motor
            const detectedVin = detectVinOrMotor(text);
            if (detectedVin) {
                userVins[phone] = detectedVin;
            }
            const currentVin = userVins[phone];
            
            let analysisMsg = "🔍 Analizando tu consulta con nuestro asistente de IA y buscando refacciones compatibles en la web... Esto puede tardar hasta un minuto. Por favor, espera.";
            if (currentVin) {
                analysisMsg = `🔍 Analizando tu consulta para el VIN/Motor *${currentVin}* con nuestro asistente de IA y buscando refacciones compatibles en la web... Esto puede tardar hasta un minuto. Por favor, espera.`;
            }
            await sendMetaMessage(phone, analysisMsg);

            let finalQuery = text;
            if (!detectedVin && currentVin) {
                finalQuery = `${text} para el VIN/Motor ${currentVin}`;
                console.log(`[AYUDA] Reutilizando VIN/Motor en caché (${currentVin}) para consulta: "${text}"`);
            }

            try {
                const pythonOutput = await runVinSearch(finalQuery);
                let responseData;
                try {
                    const trimmed = pythonOutput.trim();
                    const jsonStartIndex = trimmed.indexOf('{');
                    const jsonEndIndex = trimmed.lastIndexOf('}');
                    if (jsonStartIndex === -1 || jsonEndIndex === -1) {
                        throw new Error("No JSON block found in output");
                    }
                    const jsonStr = trimmed.substring(jsonStartIndex, jsonEndIndex + 1);
                    responseData = JSON.parse(jsonStr);
                } catch (parseErr) {
                    console.error("Error parsing python JSON:", parseErr);
                    throw new Error("No pudimos analizar la respuesta de la IA.");
                }

                if (!responseData || !responseData.success) {
                    throw new Error(responseData?.error || "Error en el agente de IA.");
                }

                if (responseData && responseData.vin) {
                    userVins[phone] = responseData.vin.trim().toUpperCase();
                    console.log(`[AYUDA] VIN/Motor guardado en memoria para ${phone}: ${userVins[phone]}`);
                }

                // 1. Mostrar respuesta conversacional en español al cliente
                const clientResponse = responseData.respuesta_cliente || "Hemos analizado tu consulta.";
                await sendMetaMessage(phone, clientResponse);
                sendMetaVoiceNote(phone, cleanTextForTTS(clientResponse)).catch(e => console.error("TTS error:", e));

                // 2. Buscar en Supabase con logs detallados en tiempo real
                let candidates = [];
                if (responseData.numeros_parte) {
                    let rawCandidates = [];
                    if (Array.isArray(responseData.numeros_parte)) {
                        rawCandidates = responseData.numeros_parte.map(c => String(c).trim()).filter(Boolean);
                    } else {
                        rawCandidates = [String(responseData.numeros_parte).trim()].filter(Boolean);
                    }
                    // Limpieza ultra-robusta de candidatos (quitar comillas, puntos, comas, espacios sobrantes)
                    candidates = rawCandidates.map(c => {
                        return c.replace(/^["'\s.,:]+|["'\s.,:]+$/g, '').trim();
                    }).filter(Boolean);
                }

                const state = user.current_state;
                console.log(`[BUSQUEDA INVENTARIO] Iniciando búsqueda para cliente ${phone} en estado: "${state || 'GLOBAL'}"`);
                console.log(`[BUSQUEDA INVENTARIO] Números de parte sugeridos por la IA (candidatos):`, candidates);

                let results = [];
                for (const partNum of candidates) {
                    if (!partNum) continue;
                    console.log(`[BUSQUEDA INVENTARIO] Buscando coincidencia para "${partNum}" en sucursales de "${state || 'TODAS'}"...`);
                    const partsFound = await searchParts(partNum, state);
                    if (partsFound && partsFound.length > 0) {
                        console.log(`   • [COMPATIBLE] Encontrada pieza en base de datos para "${partNum}":`, partsFound.map(p => `${p.part.part_number} (${p.inventory.length} sucursales)`).join(', '));
                        results.push(...partsFound);
                    } else {
                        console.log(`   • [SIN STOCK REGIONAL] No se encontró stock para "${partNum}" en "${state || 'GLOBAL'}".`);
                    }
                }

                // Eliminar duplicados si los hubiera
                const seenParts = new Set();
                results = results.filter(r => {
                    if (seenParts.has(r.part.part_number)) return false;
                    seenParts.add(r.part.part_number);
                    return true;
                });

                console.log(`[BUSQUEDA INVENTARIO] Resultados regionales finales con existencias: ${results.length}`);

                if (results.length === 0) {
                    console.log(`[BUSQUEDA INVENTARIO] Sin existencias regionales. Iniciando búsqueda nacional (global) en sucursales foráneas...`);
                    
                    // Hacer búsqueda global (nacional) en sucursales foráneas
                    let globalResults = [];
                    for (const partNum of candidates) {
                        if (!partNum) continue;
                        console.log(`[BUSQUEDA INVENTARIO] Buscando coincidencia global/foránea para "${partNum}"...`);
                        const partsFound = await searchParts(partNum, null);
                        if (partsFound && partsFound.length > 0) {
                            console.log(`   • [COMPATIBLE FORÁNEO] Encontradas existencias globales para "${partNum}":`, partsFound.map(p => `${p.part.part_number} (${p.inventory.length} sucursales)`).join(', '));
                            globalResults.push(...partsFound);
                        } else {
                            console.log(`   • [SIN STOCK GLOBAL] Tampoco hay existencias globales para "${partNum}".`);
                        }
                    }

                    // Filtrar duplicados globales
                    const seenGlobal = new Set();
                    globalResults = globalResults.filter(r => {
                        if (seenGlobal.has(r.part.part_number)) return false;
                        seenGlobal.add(r.part.part_number);
                        return true;
                    });

                    console.log(`[BUSQUEDA INVENTARIO] Resultados globales/foráneos finales: ${globalResults.length}`);

                    if (globalResults.length > 0) {
                        console.log(`[BUSQUEDA INVENTARIO] Ofreciendo existencias foráneas al cliente ${phone}...`);
                        userSearchSessions[phone] = { type: 'foreign_pending', query: text, results: globalResults };
                        await updateUser(phone, { step: 'asking_foreign' });

                        const candidatesStr = candidates.length > 0 ? ` para las refacciones sugeridas (${candidates.map(c => `*${c}*`).join(', ')})` : '';
                        const msg = `💡 No encontramos existencias en sucursales de *${state}*${candidatesStr}.\n\nSin embargo, detectamos que *sí están disponibles* en sucursales foráneas de otros estados.\n\n¿Deseas que te mostremos las opciones disponibles de otros estados para solicitarla de allá?`;

                        await sendMetaMessage(phone, null, 'interactive', {
                            type: "button",
                            body: { text: msg },
                            action: {
                                buttons: [
                                    { type: "reply", reply: { id: "VER_FORANEAS", title: "SÍ, Ver Foráneas" } },
                                    { type: "reply", reply: { id: "BUSCAR_OTRA", title: "NO, Buscar Otra" } }
                                ]
                            }
                        });
                        console.log(`[BUSQUEDA INVENTARIO] Mensaje de sucursales foráneas enviado exitosamente a ${phone}`);
                        return;
                    }

                    // No stock at all
                    console.log(`[BUSQUEDA INVENTARIO] Sin existencias a nivel nacional. Enviando mensaje de NO DISPONIBILIDAD a ${phone}...`);
                    await logAnalytics({ phone_number: phone, search_query: text, found: false, state: state });
                    await updateUser(phone, { step: 'help_no_stock_options' });
                    
                    const candidatesStr = candidates.length > 0 ? ` para las refacciones sugeridas (${candidates.map(c => `*${c}*`).join(', ')})` : '';
                    const noStockMsg = `⚠️ *Lamentamos informarle que, por el momento, no contamos con existencias de esta pieza en nuestro inventario nacional.*\n\nNo encontramos stock en ninguna de nuestras sucursales para las refacciones compatibles sugeridas${candidatesStr}.\n\n¿Qué deseas hacer ahora?`;
                    
                    await sendMetaMessage(phone, null, 'interactive', {
                        type: "button",
                        body: { text: noStockMsg },
                        action: {
                            buttons: [
                                { type: "reply", reply: { id: "BUSCAR_OTRA", title: "Buscar Otra" } },
                                { type: "reply", reply: { id: "VACIAR_CARRITO", title: "Vaciar Carrito" } },
                                { type: "reply", reply: { id: "REGRESAR_AL_INICIO", title: "Regresar al Inicio" } }
                            ]
                        }
                    });
                    console.log(`[BUSQUEDA INVENTARIO] Mensaje interactivo de NO DISPONIBILIDAD enviado a ${phone}`);
                    sendMetaVoiceNote(phone, cleanTextForTTS(noStockMsg)).catch(e => console.error("TTS error:", e));
                } else {
                    // Encontró stock localmente! Presentar opciones al cliente
                    const cart = userCarts[phone] || [];
                    let validItemsFound = 0;
                    let optionsData = {};
                    let optionCounter = 1;
                    let sections = [{ title: "Resultados Compatibles", rows: [] }];
                    let textBody = `✅ *Refacciones compatibles encontradas en existencia (${state}):*\n\n`;

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
                                const maxBranches = cart.length > 0 ? 7 : 8;
                                if (optionCounter <= maxBranches) {
                                    optionsData[optionCounter] = { part: item.part, branch: inv };
                                    textBody += `   👉 *[${optionCounter}]* ${inv.branch_name} (Stock: ${inv.stock})\n`;
                                    sections[0].rows.push({
                                        id: optionCounter.toString(),
                                        title: `[${optionCounter}] ${inv.branch_name}`.substring(0, 24).trim(),
                                        description: `Stock: ${inv.stock} | ${item.part.description} ($${item.part.price})`.substring(0, 72)
                                    });
                                    optionCounter++;
                                }
                            });
                            textBody += `\n`;
                        }
                    });

                    if (validItemsFound === 0) {
                        await updateUser(phone, { step: 'help_no_stock_options' });
                        const alertMsg = `⚠️ Las refacciones sugeridas existen en ${state}, pero el inventario ya lo tienes reservado en tu carrito.\n\n👉 Escribe *[O]* para buscar otra refacción.\n👉 Escribe *[V]* para vaciar carrito y reiniciar.\n👉 Escribe *[R]* para regresar al menú principal.`;
                        await sendMetaMessage(phone, alertMsg);
                    } else {
                        if (sections[0].rows.length > 10) {
                            sections[0].rows = sections[0].rows.slice(0, 10);
                        }

                        let optionsText = `------------------\n`;
                        optionsText += `👉 *[O]* Buscar otra pieza\n`;
                        if (cart.length > 0) {
                            optionsText += `👉 *[F]* Finalizar pedido\n`;
                        }
                        optionsText += `👉 *[V]* Vaciar y reiniciar\n`;
                        optionsText += `👉 *[R]* Regresar al inicio\n\n`;

                        const listBodyText = textBody + optionsText + "Selecciona de la lista táctil o escribe el número correspondiente para proceder con tu compra. ¡Puedes elegir varios números a la vez separados por comas o la letra 'y' (ej. 1, 3 o 1 y 2)!";
                        const interactivePayload = {
                            type: "list",
                            header: { type: "text", text: `🔎 Refacciones Disponibles` },
                            body: { text: listBodyText },
                            footer: { text: "Selecciona una sucursal para agregar" },
                            action: { button: "Ver Opciones", sections: sections }
                        };

                        userSearchSessions[phone] = {
                            optionsData: optionsData,
                            interactivePayload: interactivePayload
                        };
                        await updateUser(phone, { step: 'choosing_branch' });

                        await sendMetaMessage(phone, null, 'interactive', interactivePayload);
                        sendMetaVoiceNote(phone, `Hemos encontrado refacciones compatibles en tu estado. Por favor presiona el botón Ver Opciones en pantalla para elegir la sucursal.`).catch(e => console.error("TTS error:", e));
                    }
                }
            } catch (err) {
                console.error("Error en flujo de ayuda de VIN:", err);
                
                const isQuotaError = err.message.includes('429') || err.message.toUpperCase().includes('RESOURCE_EXHAUSTED') || err.message.toUpperCase().includes('QUOTA');
                const isPermissionError = err.message.includes('403') || err.message.toUpperCase().includes('PERMISSION_DENIED') || err.message.toUpperCase().includes('LEAK') || err.message.toUpperCase().includes('API_KEY');
                
                if (isQuotaError) {
                    console.error("❌ [API KEY EXHAUSTED] La API Key de Gemini ha agotado su cuota diaria (429 Resource Exhausted). Por favor, configure una GEMINI_API_KEY de pago o con mayor cuota en el archivo .env.");
                    const quotaUserMsg = `⚠️ Nuestro asistente de IA está experimentando una alta demanda en este momento y ha agotado su cuota diaria.\n\nPor favor, intenta de nuevo más tarde, o escribe **REINICIAR** para buscar directamente ingresando el número de parte o seleccionando tu estado sin usar el asistente de IA.`;
                    await sendMetaMessage(phone, quotaUserMsg);
                    sendMetaVoiceNote(phone, cleanTextForTTS(quotaUserMsg)).catch(e => console.error("TTS error:", e));
                } else if (isPermissionError) {
                    console.error("❌ [API KEY BLOCKED/LEAKED] La API Key de Gemini ha sido revocada o bloqueada por seguridad (403 Permission Denied - Leaked Key). Por favor, genere una nueva clave de API en Google AI Studio y actualice su archivo .env o variables de entorno en Render.");
                    const permissionUserMsg = `⚠️ Nuestro asistente de IA está fuera de servicio temporalmente por actualización de seguridad.\n\nPor favor, escribe **REINICIAR** para cotizar directamente ingresando el número de parte o seleccionando tu estado sin usar el asistente de IA.`;
                    await sendMetaMessage(phone, permissionUserMsg);
                    sendMetaVoiceNote(phone, cleanTextForTTS(permissionUserMsg)).catch(e => console.error("TTS error:", e));
                } else {
                    await sendMetaMessage(phone, `❌ Ocurrió un error inesperado al buscar la refacción por VIN: ${err.message}.\n\nPor favor, intenta de nuevo escribiendo tu consulta, o escribe **AYUDA** para reiniciar las instrucciones.`);
                }
            }
        }
        else if (step === 'help_no_stock_options') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();

            if (normalizedText === 'OTRA' || normalizedText === 'O' || normalizedText === 'BUSCAR_OTRA') {
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* deseas buscar:");
                return;
            }
            if (normalizedText === 'REINICIAR' || normalizedText === 'V' || normalizedText === 'VACIAR_CARRITO') {
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "🔄 *Conversación reiniciada*. Dime qué refacción buscas:");
                return;
            }
            if (normalizedText === 'REGRESAR' || normalizedText === 'R' || normalizedText === 'REGRESAR_AL_INICIO') {
                await updateUser(phone, { step: 'idle' });
                await processMessageLogic(phone, "hola", user.client_name || senderName);
                return;
            }
            await sendMetaMessage(phone, "⚠️ Opción inválida. Por favor, selecciona una de las opciones en los botones táctiles de tu pantalla, o escribe:\n\n- *[O]* para buscar otra refacción.\n- *[V]* para vaciar y reiniciar.\n- *[R]* para regresar al menú principal.");
        }
        else if (step === 'asking_foreign') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();

            if (normalizedText === 'SI' || normalizedText === 'SÍ' || normalizedText === 'VER_FORANEAS') {
                const sessionData = userSearchSessions[phone];
                if (!sessionData || !sessionData.results) {
                    await sendMetaMessage(phone, "⚠️ Ocurrió un problema al recuperar tu búsqueda. Por favor escribe qué refacción buscas para comenzar de nuevo:");
                    await updateUser(phone, { step: 'asking_part' });
                    return;
                }

                const results = sessionData.results;
                const cart = userCarts[phone] || [];
                let validItemsFound = 0;
                let optionsData = {};
                let optionCounter = 1;
                let sections = [{ title: "Resultados Foráneos", rows: [] }];
                let textBody = `✅ *Resultados encontrados en sucursales foráneas:*\n\n`;

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
                            const maxBranches = cart.length > 0 ? 7 : 8;
                            if (optionCounter <= maxBranches) {
                                optionsData[optionCounter] = { part: item.part, branch: inv };
                                textBody += `   👉 *[${optionCounter}]* ${inv.branch_name} (${inv.branch_state || 'Foránea'}) (Stock: ${inv.stock})\n`;
                                
                                // Truncar título a 24 caracteres máximo de WhatsApp
                                const rowTitle = `[${optionCounter}] ${inv.branch_name}`.substring(0, 24).trim();
                                // Truncar descripción a 72 caracteres máximo de WhatsApp
                                const stateText = inv.branch_state ? ` (${inv.branch_state})` : '';
                                const rowDesc = `Stock: ${inv.stock}${stateText} | ${item.part.description} ($${item.part.price})`.substring(0, 72);
                                
                                sections[0].rows.push({
                                    id: optionCounter.toString(),
                                    title: rowTitle,
                                    description: rowDesc
                                });
                                optionCounter++;
                            }
                        });
                        textBody += `\n`;
                    }
                });

                if (validItemsFound === 0) {
                    await sendMetaMessage(phone, "⚠️ Lo sentimos, el inventario foráneo de esta pieza ya lo tienes reservado en tu carrito actual.\n\nEscribe el nombre de otra pieza para seguir buscando.");
                    await updateUser(phone, { step: 'asking_part' });
                    delete userSearchSessions[phone];
                } else {
                        if (sections[0].rows.length > 10) {
                            sections[0].rows = sections[0].rows.slice(0, 10);
                        }

                        let optionsText = `------------------\n`;
                        optionsText += `👉 *[O]* Buscar otra pieza\n`;
                        if (cart.length > 0) {
                            optionsText += `👉 *[F]* Finalizar pedido\n`;
                        }
                        optionsText += `👉 *[V]* Vaciar y reiniciar\n\n`;

                        const listBodyText = textBody + optionsText + "Selecciona una sucursal foránea de la lista táctil o escribe el número correspondiente para proceder con tu compra. ¡Puedes elegir varios números a la vez separados por comas o la letra 'y' (ej. 1, 3 o 1 y 2)!";
                        const interactivePayload = {
                            type: "list",
                            header: { type: "text", text: `🔎 Opciones Foráneas` },
                            body: { text: listBodyText },
                            footer: { text: "Selecciona una sucursal foránea" },
                            action: { button: "Ver Opciones", sections: sections }
                        };

                        userSearchSessions[phone] = {
                            optionsData: optionsData,
                            interactivePayload: interactivePayload
                        };
                        await updateUser(phone, { step: 'choosing_branch' });

                        await sendMetaMessage(phone, null, 'interactive', interactivePayload);
                        sendMetaVoiceNote(phone, "Hemos encontrado las siguientes sucursales foráneas. Por favor presiona el botón Ver Opciones en tu pantalla para elegir.").catch(e => console.error("TTS error:", e));
                    }
            } else if (normalizedText === 'FINALIZAR' || normalizedText === 'CANCELAR' || normalizedText === 'NO' || normalizedText === 'BUSCAR_OTRA' || normalizedText === 'O') {
                delete userSearchSessions[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Entendido. Dime qué *otra refacción* deseas buscar:");
                sendMetaVoiceNote(phone, "Entendido. Escribe o dime qué otra refacción deseas buscar:").catch(e => console.error("TTS error:", e));
            } else if (normalizedText === 'REINICIAR' || normalizedText === 'V') {
                delete userSearchSessions[phone];
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "🔄 *Conversación reiniciada*. Dime qué refacción buscas:");
                sendMetaVoiceNote(phone, "Conversación reiniciada. Dime qué refacción buscas:").catch(e => console.error("TTS error:", e));
            } else {
                await sendMetaMessage(phone, "⚠️ Por favor presiona uno de los botones (SÍ / NO) o responde de forma clara si deseas ver las opciones de otros estados.");
            }
        }
        else if (step === 'choosing_branch') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();
            
            if ((normalizedText === 'FINALIZAR' || normalizedText === 'F') && userCarts[phone] && userCarts[phone].length > 0) {
                delete userSearchSessions[phone];
                if (user.client_name) {
                    await updateUser(phone, { step: 'confirming_order' });
                    const updatedUser = await getUser(phone);
                    await sendOrderSummaryTicket(phone, updatedUser);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    await sendMetaMessage(phone, "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?");
                }
                return;
            }
            if (normalizedText === 'OTRA' || normalizedText === 'OTRO' || normalizedText === 'SI' || normalizedText === 'O') {
                delete userSearchSessions[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* buscas:");
                return;
            }
            if (normalizedText === 'REINICIAR' || normalizedText === 'V') {
                delete userSearchSessions[phone];
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "🔄 *Conversación reiniciada*. Dime qué refacción buscas:");
                return;
            }
            if (normalizedText === 'REGRESAR' || normalizedText === 'R') {
                delete userSearchSessions[phone];
                await updateUser(phone, { step: 'idle' });
                await processMessageLogic(phone, "hola", user.client_name || senderName);
                return;
            }

            const selectedIndices = parseMultipleNumbers(text);
            const session = userSearchSessions[phone];
            const sessionData = session && session.optionsData ? session.optionsData : session;
            
            const validSelections = [];
            if (sessionData) {
                const seenInBatch = new Set();
                for (const idx of selectedIndices) {
                    if (sessionData[idx]) {
                        const item = sessionData[idx];
                        const key = `${item.part.part_number}_${item.branch.branch_id}`;
                        if (!seenInBatch.has(key)) {
                            seenInBatch.add(key);
                            validSelections.push(item);
                        }
                    }
                }
            }
            
            if (validSelections.length > 0) {
                userPendingItems[phone] = validSelections; // Save as array
                const firstSelection = validSelections[0];
                await updateUser(phone, { step: 'asking_quantity' });
                await sendMetaMessage(phone, `¿Cuántas piezas necesitas de *${firstSelection.part.description}* (Sucursal: ${firstSelection.branch.branch_name})? (Ingresa solo el número)`);
                sendMetaVoiceNote(phone, `¿Cuántas piezas necesitas de ${firstSelection.part.description}? Por favor responde escribiendo solo el número.`).catch(e => console.error("TTS error:", e));
            } else {
                await sendMetaMessage(phone, "⚠️ Opción inválida.\n\n👉 Usa el botón de la lista o escribe el número o letra correspondiente (ej. 1, O, V) para elegir.");
                sendMetaVoiceNote(phone, "Opción inválida. Usa el botón de la lista en tu pantalla o menciona el número o letra de opción correspondiente.").catch(e => console.error("TTS error:", e));
            }
        }
        // ✅ NUEVO STEP: CONFIRMAR VIN O MOTOR
        else if (step === 'confirming_vin') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();
            const pendingData = userPendingItems[phone];
            
            if (!pendingData) {
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "⚠️ Sesión expirada. Por favor dime qué refacción buscas:");
                return;
            }
            
            if (normalizedText === 'SI' || normalizedText === 'SÍ') {
                // Confirmado - proceder con búsqueda en la sección de ayuda/VIN
                await updateUser(phone, { step: 'asking_help_details' });
                if (pendingData.vin) {
                    userVins[phone] = pendingData.vin.trim().toUpperCase();
                } else if (pendingData.motor) {
                    userVins[phone] = pendingData.motor.trim().toUpperCase();
                }
                delete userPendingItems[phone];
                const searchText = pendingData.partText || pendingData.originalText;
                await sendMetaMessage(phone, `✅ VIN/Motor confirmado. Buscando *${searchText}* ahora...`);
                await processMessageLogic(phone, searchText, '');
            } else if (normalizedText === 'NO') {
                await updateUser(phone, { step: 'asking_part' });
                delete userPendingItems[phone];
                await sendMetaMessage(phone, "👍 Entendido. Por favor envía nuevamente: VIN/Motor y la refacción (ej: *ABC1234567890DEFG Filtro de aceite*):");
            } else {
                await sendMetaMessage(phone, "⚠️ Responde SÍ si es correcto o NO para corregir.");
            }
        }
        else if (step === 'asking_quantity') {
            const spokenIntent = parseSpokenIntent(text);
            const normalizedText = spokenIntent || text.toUpperCase().trim();

            if (normalizedText === 'REGRESAR') {
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

            if (normalizedText === 'OTRA' || normalizedText === 'OTRO' || normalizedText === 'SI' || normalizedText === 'O') {
                delete userSearchSessions[phone];
                delete userPendingItems[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* buscas:");
                return;
            }

            if (normalizedText === 'REINICIAR' || normalizedText === 'V') {
                delete userSearchSessions[phone];
                delete userPendingItems[phone];
                delete userCarts[phone];
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "🔄 *Conversación reiniciada*. Dime qué refacción buscas:");
                return;
            }

            if ((normalizedText === 'FINALIZAR' || normalizedText === 'F') && userCarts[phone] && userCarts[phone].length > 0) {
                delete userSearchSessions[phone];
                delete userPendingItems[phone];
                if (user.client_name) {
                    await updateUser(phone, { step: 'confirming_order' });
                    const updatedUser = await getUser(phone);
                    await sendOrderSummaryTicket(phone, updatedUser);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    const msg = "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?";
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                }
                return;
            }

            const quantity = parseSpokenNumber(text);
            if (isNaN(quantity) || quantity <= 0) {
                await sendMetaMessage(phone, "⚠️ Por favor ingresa un número válido (ej. 1, 2, 3), o responde *REGRESAR* para ver las opciones.");
                sendMetaVoiceNote(phone, "Por favor ingresa un número de piezas válido, o responde REGRESAR para ver las opciones de sucursales.").catch(e => console.error("TTS error:", e));
                return;
            }
            
            let pendingQueue = userPendingItems[phone];
            if (!pendingQueue) {
                await sendMetaMessage(phone, "⚠️ Hubo un error recuperando tu pieza. Por favor, escribe 'Reiniciar'.");
                return;
            }

            // Convert to array if it is a single item (for robustness/backwards compatibility)
            if (!Array.isArray(pendingQueue)) {
                pendingQueue = [pendingQueue];
                userPendingItems[phone] = pendingQueue;
            }

            const pendingItem = pendingQueue[0];
            if (!pendingItem || !pendingItem.branch) {
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
            
            const existingIndex = userCarts[phone].findIndex(cartItem => 
                cartItem.part.part_number === pendingItem.part.part_number && 
                cartItem.branch.branch_id === pendingItem.branch.branch_id
            );
            
            if (existingIndex !== -1) {
                userCarts[phone][existingIndex].quantity += quantity;
            } else {
                userCarts[phone].push({ ...pendingItem, quantity });
            }
            
            // Remove the processed item
            pendingQueue.shift();
            
            if (pendingQueue.length > 0) {
                // There are more items in the queue!
                const nextSelection = pendingQueue[0];
                await sendMetaMessage(phone, `✅ Agregado al carrito.\n\nAhora, ¿cuántas piezas necesitas de *${nextSelection.part.description}* (Sucursal: ${nextSelection.branch.branch_name})? (Ingresa solo el número)`);
                sendMetaVoiceNote(phone, `Agregado al carrito. Ahora, ¿cuántas piezas necesitas de ${nextSelection.part.description}? Por favor responde escribiendo solo el número.`).catch(e => console.error("TTS error:", e));
                return;
            }
            
            // Queue finished! Clean up pending items
            delete userPendingItems[phone];
            
            // Do NOT delete userSearchSessions[phone] to allow return to results!
            await updateUser(phone, { step: 'asking_more' });
            
            const hasSession = !!userSearchSessions[phone];
            const buttons = [];
            
            if (hasSession) {
                buttons.push({ type: "reply", reply: { id: "SEGUIR_COMPRANDO", title: "Regresar a Lista [S]" } });
                buttons.push({ type: "reply", reply: { id: "O", title: "Buscar Otra [O]" } });
                buttons.push({ type: "reply", reply: { id: "F", title: "Finalizar [F]" } });
            } else {
                buttons.push({ type: "reply", reply: { id: "O", title: "Buscar Otra [O]" } });
                buttons.push({ type: "reply", reply: { id: "F", title: "Finalizar [F]" } });
                buttons.push({ type: "reply", reply: { id: "V", title: "Vaciar Todo [V]" } });
            }
            
            let msgText = `✅ ¡Pieza(s) agregada(s) a tu carrito! (Llevas ${userCarts[phone].length} artículo/s).\n\n¿Qué deseas hacer a continuación?`;
            if (hasSession) {
                msgText += `\n\n👉 *[S]* Regresar a los resultados de búsqueda previos.\n👉 *[O]* Buscar otra refacción diferente.\n👉 *[F]* Finalizar tu pedido.`;
            } else {
                msgText += `\n\n👉 *[O]* Buscar otra refacción.\n👉 *[F]* Finalizar tu pedido.\n👉 *[V]* Vaciar carrito y reiniciar.`;
            }

            await sendMetaMessage(phone, null, 'interactive', {
                type: "button",
                body: { text: msgText },
                action: { buttons }
            });
            
            let voiceText = `¡Pieza agregada a tu carrito! Llevas ${userCarts[phone].length} artículos en tu pedido. `;
            if (hasSession) {
                voiceText += `¿Deseas regresar a la lista de resultados, buscar otra refacción o finalizar tu pedido?`;
            } else {
                voiceText += `¿Deseas buscar otra refacción, finalizar el pedido o vaciar el carrito?`;
            }
            sendMetaVoiceNote(phone, voiceText).catch(e => console.error("TTS error:", e));
        }
        else if (step === 'asking_more') {
            const spokenIntent = parseSpokenIntent(text);
            const res = (spokenIntent || text.toUpperCase().trim()).replace(/[\[\]]/g, "");
            const session = userSearchSessions[phone];
            
            // Check if they want to return to the search list
            if (res === 'SEGUIR_COMPRANDO' || res === 'REGRESAR A LISTA S' || res === 'S' || res === 'REGRESAR' || res === 'LISTA') {
                if (session && session.interactivePayload) {
                    await updateUser(phone, { step: 'choosing_branch' });
                    await sendMetaMessage(phone, null, 'interactive', session.interactivePayload);
                    sendMetaVoiceNote(phone, `Regresando a los resultados de búsqueda. Por favor presiona Ver Opciones en pantalla para elegir otra sucursal o refacción.`).catch(e => console.error("TTS error:", e));
                    return;
                } else {
                    // Fallback to searching a new part if no session exists
                    await updateUser(phone, { step: 'asking_part' });
                    await sendMetaMessage(phone, "⚠️ No se encontró una búsqueda previa activa. Dime qué *otra refacción* deseas buscar:");
                    return;
                }
            }

            if (res === 'SI' || res === 'SÍ' || res === 'O' || res === 'BUSCAR OTRA O' || res === 'BUSCAR_OTRA') {
                delete userSearchSessions[phone]; // Clean up the session since they want a new search
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "Dime qué *otra refacción* buscas:");
                sendMetaVoiceNote(phone, "Entendido. Dime qué otra refacción buscas:").catch(e => console.error("TTS error:", e));
            } else if (res === 'NO' || res === 'N' || res === 'FINALIZAR' || res === 'F' || res === 'FINALIZAR F') {
                delete userSearchSessions[phone]; // Clean up the session
                if (user.client_name) {
                    await updateUser(phone, { step: 'confirming_order' });
                    const updatedUser = await getUser(phone);
                    await sendOrderSummaryTicket(phone, updatedUser);
                } else {
                    await updateUser(phone, { step: 'asking_name' });
                    const msg = "Para tu cotización y facturación:\n\n¿A nombre de qué *persona o empresa* se hará la factura?";
                    await sendMetaMessage(phone, msg);
                    sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
                }
            } else if (res === 'CANCELAR' || res === 'V' || res === 'VACIAR TODO V' || res === 'VACIAR') {
                delete userSearchSessions[phone]; // Clean up the session
                delete userCarts[phone];
                delete userVins[phone];
                await updateUser(phone, { step: 'asking_part' });
                const msg = "🗑️ Carrito vaciado correctamente.\n\nDime qué refacción buscas ahora:";
                await sendMetaMessage(phone, msg);
                sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
            } else {
                await sendMetaMessage(phone, "⚠️ Por favor presiona uno de los botones o responde de forma clara.");
            }
        }
        else if (step === 'asking_name') {
            const clientName = text;
            await updateUser(phone, { client_name: clientName });
            await updateUser(phone, { step: 'confirming_order' });
            const updatedUser = await getUser(phone);
            await sendOrderSummaryTicket(phone, updatedUser);
        }
        else if (step === 'confirming_order') {
            const buttonId = text.trim().toUpperCase();
            
            if (buttonId === 'CONFIRMAR_PEDIDO' || buttonId === 'CONFIRMAR' || buttonId === 'C') {
                await processOrder(phone, user.client_name, user.client_number || 'Nuevo Registro', user.current_state);
            } 
            else if (buttonId === 'MODIFICAR_CARRITO' || buttonId === 'MODIFICAR' || buttonId === 'M') {
                const cart = userCarts[phone] || [];
                if (cart.length === 0) {
                    await updateUser(phone, { step: 'asking_part' });
                    await sendMetaMessage(phone, "🛒 Tu carrito está vacío. Dime qué refacción deseas buscar:");
                    return;
                }
                
                await updateUser(phone, { step: 'modifying_cart_select_item' });
                
                let msg = `🛠️ *MODIFICAR PIEZAS DEL CARRITO* 🛠️\n\n`;
                msg += `Escribe el *número* del artículo que deseas modificar o eliminar:\n\n`;
                cart.forEach((item, index) => {
                    msg += `*${index + 1}.* ${item.quantity}x ${item.part.description} (${item.part.part_number}) - Sucursal: ${item.branch.branch_name}\n`;
                });
                msg += `\n👉 Escribe el número del artículo (ej. *1*) o escribe *REGRESAR* para volver al resumen del pedido.`;
                
                await sendMetaMessage(phone, msg);
                sendMetaVoiceNote(phone, "Por favor escribe el número del artículo que deseas modificar de la lista en pantalla, o escribe REGRESAR para volver.").catch(e => console.error("TTS error:", e));
            } 
            else if (buttonId === 'SEGUIR_COMPRANDO' || buttonId === 'SEGUIR' || buttonId === 'O') {
                await updateUser(phone, { step: 'asking_part' });
                await sendMetaMessage(phone, "👍 Excelente. Dime qué *otra refacción* deseas buscar para agregar al carrito:");
                sendMetaVoiceNote(phone, "Excelente. Dime qué otra refacción deseas buscar para agregar al carrito.").catch(e => console.error("TTS error:", e));
            } 
            else if (buttonId === 'VACIAR' || buttonId === 'V') {
                delete userCarts[phone];
                delete userVins[phone];
                await updateUser(phone, { step: 'asking_part' });
                const msg = "🗑️ Carrito vaciado correctamente.\n\nDime qué refacción deseas buscar ahora:";
                await sendMetaMessage(phone, msg);
                sendMetaVoiceNote(phone, msg).catch(e => console.error("TTS error:", e));
            }
            else {
                await sendMetaMessage(phone, "⚠️ Opción no válida. Por favor selecciona una de las opciones en pantalla:\n\n- *Confirmar Pedido* para enviar al vendedor.\n- *Modificar* para cambiar cantidades.\n- *Seguir Comprando* para añadir más refacciones.\n\nO escribe *REGRESAR* para ver el resumen de nuevo.");
            }
        }
        else if (step === 'modifying_cart_select_item') {
            const cleanText = text.trim().toUpperCase();
            if (cleanText === 'REGRESAR' || cleanText === 'CANCELAR' || cleanText === 'R') {
                await updateUser(phone, { step: 'confirming_order' });
                await sendOrderSummaryTicket(phone, user);
                return;
            }
            
            const selectedIdx = parseSpokenNumber(text);
            const cart = userCarts[phone] || [];
            
            if (isNaN(selectedIdx) || selectedIdx <= 0 || selectedIdx > cart.length) {
                await sendMetaMessage(phone, `⚠️ Selección no válida. Por favor ingresa el número de artículo correspondiente (del 1 al ${cart.length}) o escribe *REGRESAR*:`);
                return;
            }
            
            const itemToMod = cart[selectedIdx - 1];
            userSearchSessions[phone] = { ...userSearchSessions[phone], modifyingIndex: selectedIdx - 1 };
            
            await updateUser(phone, { step: 'modifying_cart_input_quantity' });
            
            const msg = `✏️ *Modificando:* ${itemToMod.part.description} (${itemToMod.part.part_number})\n`;
            msg += `Sucursal: ${itemToMod.branch.branch_name} | Stock disponible: ${itemToMod.branch.stock}\n`;
            msg += `Cantidad actual: *${itemToMod.quantity}*\n\n`;
            msg += `👉 Ingresa la *nueva cantidad* que deseas (ej. *3*).\n`;
            msg += `💡 _Escribe *0* si deseas eliminar por completo esta pieza del carrito._`;
            
            await sendMetaMessage(phone, msg);
            sendMetaVoiceNote(phone, `Ingresa la nueva cantidad que deseas para esta pieza, o escribe cero si deseas eliminarla por completo.`).catch(e => console.error("TTS error:", e));
        }
        else if (step === 'modifying_cart_input_quantity') {
            const cleanText = text.trim().toUpperCase();
            if (cleanText === 'CANCELAR' || cleanText === 'REGRESAR' || cleanText === 'R') {
                await updateUser(phone, { step: 'confirming_order' });
                await sendOrderSummaryTicket(phone, user);
                return;
            }
            
            const newQty = parseSpokenNumber(text);
            if (isNaN(newQty) || newQty < 0) {
                await sendMetaMessage(phone, "⚠️ Por favor ingresa una cantidad numérica válida (0 o mayor):");
                return;
            }
            
            const session = userSearchSessions[phone];
            const modIdx = session ? session.modifyingIndex : -1;
            const cart = userCarts[phone] || [];
            
            if (modIdx === -1 || modIdx === undefined || !cart[modIdx]) {
                await updateUser(phone, { step: 'confirming_order' });
                await sendMetaMessage(phone, "⚠️ Ocurrió un error al identificar el artículo. Regresando al resumen de pedido...");
                await sendOrderSummaryTicket(phone, user);
                return;
            }
            
            const item = cart[modIdx];
            
            if (newQty === 0) {
                cart.splice(modIdx, 1);
                await sendMetaMessage(phone, `🗑️ Se ha eliminado *${item.part.description}* de tu pedido.`);
                
                if (cart.length === 0) {
                    await updateUser(phone, { step: 'asking_part' });
                    await sendMetaMessage(phone, "🛒 Tu carrito ahora está vacío. Dime qué refacción deseas buscar:");
                } else {
                    await updateUser(phone, { step: 'confirming_order' });
                    await sendOrderSummaryTicket(phone, user);
                }
            } else {
                await sendMetaMessage(phone, "⏱️ Verificando inventario...");
                const { data: invRecord, error: invErr } = await supabase
                    .from('inventory')
                    .select('stock')
                    .eq('branch_id', item.branch.branch_id)
                    .eq('part_number', item.part.part_number)
                    .maybeSingle();
                
                if (invErr) {
                    console.error("Error consultando inventario:", invErr);
                }
                
                const realStock = invRecord ? invRecord.stock : item.branch.stock;
                item.branch.stock = realStock;
                
                if (newQty > realStock) {
                    await sendMetaMessage(phone, `⚠️ Lo sentimos, solo tenemos *${realStock}* pieza(s) disponible(s) de este artículo en esta sucursal.\n\nPor favor ingresa una cantidad menor o igual a ${realStock}, o escribe *0* para eliminarlo:`);
                    return;
                }
                
                item.quantity = newQty;
                await sendMetaMessage(phone, `✅ Cantidad actualizada a *${newQty}* pieza(s) con éxito.`);
                await updateUser(phone, { step: 'confirming_order' });
                await sendOrderSummaryTicket(phone, user);
            }
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
    delete userVins[phone];
}
