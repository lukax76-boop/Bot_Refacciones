# 🤖 Bot de Cotizaciones de Refacciones (WhatsApp + Web Dashboard)

Este documento detalla la arquitectura, funcionalidad, diseño y configuración del sistema integral desarrollado para la automatización de cotizaciones de autopartes vía WhatsApp.

---

## 1. 🚀 Descripción Funcional de la Aplicación

El sistema consta de dos módulos principales: un **Bot de WhatsApp interactivo** orientado al cliente final, y un **Panel de Control (Dashboard) Web** orientado a los administradores.

### Flujo del Bot de WhatsApp
1. **Detección Automática de Ubicación:** Al recibir el primer mensaje (ej. "Hola"), el bot analiza el Código de Área (LADA) del número telefónico. Si reconoce la LADA, asigna el Estado de la República automáticamente sin preguntarle al usuario.
2. **Búsqueda Avanzada:** El cliente ingresa el nombre o número de pieza. El sistema realiza una búsqueda *Case-Insensitive* (ignora mayúsculas/minúsculas) en la base de datos de Supabase.
3. **Filtro Regional:** El bot cruza la pieza solicitada con el inventario exclusivo de las sucursales del Estado del cliente.
4. **Respuesta Inteligente:** 
   - Si la encuentra, devuelve una lista de opciones numeradas con la sucursal, cantidad disponible y precio.
   - Si no la encuentra, registra una **"Venta Perdida"** silenciosamente en la base de datos y le avisa al cliente.
5. **Cierre de Venta (Handoff):** Si el cliente elige una sucursal, el bot confirma el pedido y envía una notificación automatizada con un enlace directo (`wa.me`) al WhatsApp del Agente de Ventas de esa sucursal en específico, permitiendo un contacto humano para el cobro y entrega.
6. **Comandos Globales:** El usuario puede enviar la palabra `ESTADO` en cualquier momento para cambiar manualmente de región geográfica, o `REINICIAR` para cancelar su flujo actual.

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
El repositorio incluye un `Dockerfile` optimizado y un `.dockerignore`.
Para desplegar en servicios en la nube (ej. Render):
1. El contenedor instala una versión nativa de Chromium (`ghcr.io/puppeteer/puppeteer`).
2. Se inyecta la variable `PUPPETEER_EXECUTABLE_PATH`.
3. Al iniciar (`npm start`), el servidor levanta Puppeteer. El código QR debe ser escaneado **desde los logs de la consola** del proveedor de nube para establecer la sesión inicial en el contenedor.
