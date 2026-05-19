# 🤖 Bot de Cotizaciones de Refacciones (WhatsApp + Web Dashboard)

Este documento detalla la arquitectura, funcionalidad, diseño y configuración del sistema integral desarrollado para la automatización de cotizaciones de autopartes vía WhatsApp.

---

## 1. 🚀 Descripción Funcional de la Aplicación

El sistema consta de dos módulos principales: un **Bot de WhatsApp interactivo** orientado al cliente final, y un **Panel de Control (Dashboard) Web** orientado a los administradores.

### Flujo del Bot de WhatsApp
1. **Detección Automática de Ubicación:** Al recibir el primer mensaje (ej. "Hola"), el bot analiza el Código de Área (LADA) del número telefónico. Si reconoce la LADA, asigna el Estado de la República automáticamente sin preguntarle al usuario.
2. **Selección Geográfica Táctil (Touch List):** Si no se puede reconocer el estado por LADA o el cliente envía el comando `ESTADO`, el bot despliega una **Lista Interactiva Táctil** nativa de WhatsApp con los estados disponibles, permitiéndole al usuario pulsar directamente sobre su región.
3. **Búsqueda Avanzada:** El cliente ingresa el nombre o número de pieza (mediante texto o nota de voz). El sistema realiza una búsqueda *Case-Insensitive* (ignora mayúsculas/minúsculas) en la base de datos de Supabase.
4. **Filtro Regional:** El bot cruza la pieza solicitada con el inventario exclusivo de las sucursales del Estado del cliente.
5. **Respuesta Inteligente y Táctil:** 
   - Si la encuentra, devuelve una lista interactiva de opciones numeradas con la sucursal, cantidad disponible y precio, que el usuario puede elegir haciendo clic sobre la pantalla.
   - Si no la encuentra, registra una **"Venta Perdida"** silenciosamente en la base de datos y le avisa al cliente.
6. **Text-to-Speech (TTS) Multimodal:** Para enriquecer la interacción, cada respuesta conversacional del bot (mensajes de bienvenida, errores de búsqueda, confirmaciones de inventario o éxito de compra) va acompañada de una **Nota de voz personalizada de alta definición (TTS)** generada asíncronamente con el modelo de síntesis de voz de OpenAI (`tts-1`). Esto permite una experiencia auditiva premium. El bot cuenta con un fallback transparente: si las API de voz fallan o no están configuradas, opera limpiamente en modo texto puro sin detenerse.
7. **Cierre de Venta (Handoff):** Si el cliente elige una sucursal, el bot confirma el pedido y envía una notificación automatizada con un enlace directo (`wa.me`) al WhatsApp del Agente de Ventas de esa sucursal en específico, permitiendo un contacto humano para el cobro y entrega.
8. **Comandos Globales:** El usuario puede enviar la palabra `ESTADO` en cualquier momento para cambiar manualmente de región geográfica, o `REINICIAR` para cancelar su flujo actual.


---

## 2. 🎨 Diseño e Interfaz (Dashboard Web)

El panel de administración web (`http://localhost:3000`) fue diseñado utilizando los principios modernos de **Glassmorphism**, lo que le otorga un aspecto *premium*, vibrante y tecnológico.

### Elementos de Diseño:
*   **Modo Oscuro Profundo:** Fondo azul noche (`#0f172a`) con gradientes sutiles.
*   **Paneles de Cristal:** Tarjetas translúcidas con desenfoque de fondo (`backdrop-filter: blur`) y bordes semitransparentes.
*   **Tipografía Moderna:** Uso de la fuente *Outfit* de Google Fonts para una lectura clara y contemporánea.
*   **Interactividad:** Animaciones suaves al pasar el cursor (`hover`) y un área interactiva de "Drag & Drop" para subir archivos.

### Módulos del Dashboard:
1. **Métricas Rápidas:** Tarjetas superiores mostrando Búsquedas Totales, Pedidos Solicitados y Ventas Perdidas.
2. **Reportes Estadísticos Detallados:**
   *   *Oportunidades Perdidas:* Tabla que muestra Fecha, Estado y la Búsqueda que fracasó. Ideal para decisiones de compras de inventario.
   *   *Ventas por Estado:* Tabla que muestra Fecha, Estado, Pieza y Sucursal que cerró la venta.
   *   *Ambas tablas cuentan con botón de exportación a archivo CSV (Excel).*
3. **Carga de Inventario Masivo:** Un área para arrastrar y soltar archivos Excel (`.xlsx`), diseñada para actualizar toda la base de datos de piezas de golpe.

---

## 3. ⚙️ Arquitectura y Configuración Tecnológica

El sistema es robusto, modular y está preparado para despliegue en la nube (Dockerizado).

### Stack Tecnológico
*   **Backend / Lógica:** Node.js + Express.js.
*   **Conexión a WhatsApp:** Librería `whatsapp-web.js` (basada en Puppeteer / Google Chrome Headless).
*   **Base de Datos:** Supabase (PostgreSQL en la nube). Relacional, segura y rápida.
*   **Despliegue (Cloud):** Preparado para Render.com o VPS mediante `Dockerfile` nativo.

### Variables de Entorno (`.env`)
El proyecto requiere un archivo `.env` en la raíz con las credenciales de conexión:
```env
PORT=3000
SUPABASE_URL="https://tu-proyecto.supabase.co"
SUPABASE_KEY="tu-llave-anon-public-aqui"
```

### Base de Datos (Estructura Supabase)
El sistema depende de 5 tablas relacionales:
1.  **`branches` (Sucursales):** Guarda nombre, estado, dirección y el teléfono del agente de ventas (`agent_phone`).
2.  **`parts` (Catálogo):** Catálogo maestro con `part_number`, descripción y precio base.
3.  **`inventory` (Inventario local):** Tabla pivote que cruza `branch_id` con `part_number` e incluye la cantidad (`stock`).
4.  **`users` (Máquina de Estados):** Rastrea en qué paso de la conversación se encuentra cada número telefónico (`idle`, `asking_state`, `asking_part`, `choosing_branch`).
5.  **`analytics` (Métricas):** Guarda un log histórico de cada evento de búsqueda y compra.

### Despliegue en la Nube

El bot y el panel de administración están diseñados bajo una arquitectura **totalmente en la nube**. Al utilizar la **API de Meta Cloud** en lugar de automatización de navegador local (Puppeteer), el despliegue es sumamente simple, rápido y consume mínimos recursos.

#### Dockerfile Optimizado (Alpine Linux)
El repositorio incluye un `Dockerfile` basado en **Node.js 22-Alpine**, el cual:
1. Pesa aproximadamente **100MB** (en lugar de los 1.5GB requeridos por entornos con navegadores Chromium instalados).
2. Se compila e implementa en segundos.
3. No requiere configuraciones de variables Puppeteer ni descargas de Chromium adicionales.

#### Pasos para Desplegar en la Nube (ej. Render.com, Railway o VPS)
1. **Crear Servicio Web:** Vincula tu repositorio de GitHub a tu proveedor de hosting en la nube (ej. Render o Railway).
2. **Configurar el Entorno:** Inyecta las siguientes variables de entorno en el panel de control de tu proveedor:
   *   `PORT=3000`
   *   `META_ACCESS_TOKEN` (Tu Token de Acceso Permanente o Temporal de Meta Developer Portal)
   *   `META_PHONE_NUMBER_ID` (El identificador de número telefónico de tu aplicación de Meta)
   *   `META_WEBHOOK_VERIFY_TOKEN` (El token secreto para validar tu webhook, ej. `refacciones_webhook_token_123`)
   *   `OPENAI_API_KEY` (Para transcripción de notas de voz de clientes y respuestas TTS)
   *   `SUPABASE_URL` y `SUPABASE_KEY` (Credenciales de tu base de datos en Supabase)
3. **Configurar Webhook en Meta Portal:**
   *   Una vez que tu aplicación esté activa en la nube (ej. `https://refacciones-bot.onrender.com`), entra a tu portal de desarrolladores en **Meta (Developers.facebook.com)**.
   *   En la sección de WhatsApp > Configuración de Webhook, establece la URL de Callback como:
       `https://tu-app-en-la-nube.onrender.com/webhook`
   *   Ingresa el valor de `META_WEBHOOK_VERIFY_TOKEN` en el campo correspondiente para completar el enlace.
   *   ¡Listo! Todo el tráfico de WhatsApp, la base de datos de inventarios y los servicios de voz operarán en tiempo real de forma 100% cloud.

