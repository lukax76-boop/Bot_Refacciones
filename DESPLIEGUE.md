# 🚀 GUÍA DE DESPLIEGUE COMPLETO: WhatsApp Bot & Dashboard en la Nube

Esta guía te guiará paso a paso para desplegar tu bot de refacciones con la **API oficial de Meta Cloud**, la integración de **OpenAI (TTS/STT)**, y tu base de datos de **Supabase**, utilizando **Render.com** (o cualquier VPS / servicio en la nube).

---

## 📋 Requisitos Previos
1. Una cuenta de desarrollador en [Meta Developers](https://developers.facebook.com/).
2. Una cuenta en [Render.com](https://render.com/) (o servicio cloud equivalente).
3. Tu base de datos de Supabase ya configurada (con las tablas creadas mediante `schema.sql`).
4. Cuenta de OpenAI con saldo disponible para generación de TTS y transcripciones Whisper.

---

## 🛠️ Paso 1: Configurar tu App de WhatsApp en Meta

1. **Crear una Cuenta de Desarrollador:**
   - Ve a [Meta Developers](https://developers.facebook.com/) e inicia sesión con tu cuenta de Facebook.
   - Si es tu primera vez, regístrate como desarrollador completando el formulario.

2. **Crear una Nueva Aplicación:**
   - Haz clic en **Mis aplicaciones** > **Crear app**.
   - Selecciona el tipo de app **Otro** o **Negocios** y presiona Siguiente.
   - Elige **Negocios** (Business) para el acceso al producto de WhatsApp.
   - Dale un nombre descriptivo (ej. `Cotizador Refacciones`) y asóciala a tu cuenta comercial de Meta Business Suite (si tienes una; si no, déjala sin asignar para usar la sandbox de pruebas).

3. **Agregar el Producto de WhatsApp:**
   - Una vez en el panel de tu App de Meta, desplázate hacia abajo y en **WhatsApp** haz clic en **Configurar**.
   - Esto creará automáticamente un entorno de pruebas con un número sandbox.

4. **Obtener tus Credenciales de Meta:**
   - Ve a **WhatsApp** > **Configuración de la API** en la barra lateral izquierda.
   - En la sección **Identificador de número de teléfono** (Phone Number ID), copia ese número. Este será tu variable `META_PHONE_NUMBER_ID` en el `.env`.
   - Copia el **Token de acceso temporal** (Temporary Access Token) que aparece arriba. Este será tu variable `META_ACCESS_TOKEN`.
     *(Nota: En producción, deberás generar un System User Token permanente en tu Meta Business Manager para que no expire a las 24 horas).*
   - Agrega tu número de teléfono celular personal en la sección de **Destinatarios de prueba** a la derecha para que puedas enviarte mensajes de prueba en el entorno sandbox.

---

## 🌐 Paso 2: Desplegar la Aplicación en Render.com

Render.com detectará el `Dockerfile` optimizado automáticamente para compilar e iniciar el servidor Node.js de forma ligera ( Alpine Linux de ~100MB) y segura.

1. **Subir tu Proyecto a GitHub:**
   - Inicializa git, añade tus archivos y sube tu proyecto a un repositorio privado o público en GitHub.
     ```bash
     git init
     git add .
     git commit -m "feat: migracion completa a meta cloud api y health checks"
     # Vincula tu repositorio remoto y haz push
     ```

2. **Crear un Servicio Web en Render:**
   - Inicia sesión en [Render.com](https://render.com/) y haz clic en **New +** > **Web Service**.
   - Vincula tu cuenta de GitHub y selecciona el repositorio de tu proyecto.

3. **Configurar los Detalles del Despliegue:**
   - **Name:** `whatsapp-bot-refacciones` (o el que desees).
   - **Environment:** Selecciona **Docker** (Render detectará automáticamente tu `Dockerfile` y no tendrás que configurar comandos de inicio ni de compilación).
   - **Region:** Selecciona la más cercana (ej. `Oregon, US` u `Ohio, US`).
   - **Branch:** `main` (o la rama de tu repositorio).
   - **Instance Type:** Selecciona la versión **Free** (Gratuita).

4. **Inyectar las Variables de Entorno (Environment Variables):**
   Haz clic en la pestaña **Advanced** y añade las siguientes variables clave que el sistema requiere:

   | Variable | Valor / Descripción |
   |---|---|
   | `PORT` | `3000` |
   | `SUPABASE_URL` | Tu URL de Supabase (ej. `https://xxx.supabase.co`) |
   | `SUPABASE_KEY` | Tu llave pública anon-public de Supabase |
   | `OPENAI_API_KEY` | Tu API Key de OpenAI (ej. `sk-proj-xxx`) |
   | `META_ACCESS_TOKEN` | Tu Token de acceso de Meta Developer |
   | `META_PHONE_NUMBER_ID` | Tu Identificador de número de teléfono copiado de Meta |
   | `META_WEBHOOK_VERIFY_TOKEN` | Una clave secreta inventada por ti (ej. `mi_clave_secreta_refacciones_123`) |

5. **Desplegar:**
   - Haz clic en **Create Web Service**.
   - Render comenzará a construir la imagen Docker. Esto tomará aproximadamente de 1 a 2 minutos.
   - Una vez desplegado con éxito, Render te dará una URL pública (ej. `https://whatsapp-bot-refacciones.onrender.com`). **Cópiala**.

---

## 🔗 Paso 3: Enlazar el Webhook en el Portal de Meta Developers

Para que Meta sepa a dónde enviar los mensajes en tiempo real cuando un cliente le escriba al bot, debes configurar el Webhook con la URL pública de tu servidor de Render.

1. **Configurar el Webhook:**
   - Regresa al portal de [Meta Developers](https://developers.facebook.com/) y entra a tu App.
   - En la barra lateral izquierda, ve a **WhatsApp** > **Configuración**.
   - En la sección **Webhook**, haz clic en **Editar**.
   - **URL de callback:** Ingresa la URL pública que te dio Render terminada en `/webhook`.
     *Ejemplo:* `https://whatsapp-bot-refacciones.onrender.com/webhook`
   - **Token de verificación:** Ingresa la clave secreta que definiste en la variable de entorno `META_WEBHOOK_VERIFY_TOKEN` (ej. `mi_clave_secreta_refacciones_123`).
   - Haz clic en **Verificar y guardar**. Meta hará una petición rápida a tu servidor de Render para validar el token y lo guardará.

2. **Suscribirse a los Eventos de Mensajes:**
   - Una vez verificado el webhook, en el mismo panel verás una sección de campos del webhook.
   - Haz clic en **Administrar** o busca el evento **`messages`**.
   - Haz clic en **Suscribirse** al lado del campo de `messages`.
   - ¡Listo! A partir de este momento, todos los mensajes de texto y voz entrantes se redirigirán instantáneamente a tu bot de Render.

---

## 🧪 Paso 4: ¡Prueba tu Bot!

1. Ve a la sección **WhatsApp > Configuración de la API** en Meta Developers.
2. Presiona el botón **Enviar mensaje** de prueba para mandar un mensaje desde el número sandbox al número de celular que registraste como destinatario de prueba.
3. Abre ese chat de prueba en tu teléfono móvil y escribe `"Hola"` o envíale un **mensaje de voz (audio)** buscando alguna pieza.
4. El bot responderá en texto y te enviará una **nota de voz sintetizada (TTS)** explicándote las opciones del catálogo.
5. Abre la URL pública de tu Render (ej. `https://whatsapp-bot-refacciones.onrender.com`) en tu navegador:
   - Verás tu elegante **Dashboard Glassmorphism** en línea.
   - El panel superior de **Estatus General** te mostrará en tiempo real si la base de datos de Supabase, la API de OpenAI y las credenciales de Meta están en verde (CONECTADO/CONFIGURADO).
   - Podrás descargar las plantillas de Excel oficiales, cargar nuevos inventarios masivos y ver las métricas de compras exitosas y ventas perdidas en tiempo real.
