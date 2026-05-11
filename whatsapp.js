const axios = require('axios');
require('dotenv').config();

const token = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.WHATSAPP_PHONE_ID;

/**
 * Enviar un mensaje de texto por WhatsApp a un número específico
 * @param {string} to Número de teléfono destino (ej. '5215555555555')
 * @param {string} text Texto a enviar
 */
async function sendMessage(to, text) {
    if (!token || !phoneId || token === 'tu_token_de_acceso_temporal_aqui') {
        console.warn(`⚠️ Simulando envío de mensaje a ${to}: "${text}" (Credenciales no configuradas)`);
        return;
    }

    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${phoneId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text },
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log(`Mensaje enviado a ${to}`);
    } catch (error) {
        console.error('Error enviando mensaje de WhatsApp:', error.response ? error.response.data : error.message);
    }
}

module.exports = {
    sendMessage
};
