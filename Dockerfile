FROM node:22-alpine

WORKDIR /app

# Instalar Python y pip en Alpine Linux
RUN apk add --no-cache python3 py3-pip

# Instalar librerías de Python requeridas por vin_search.py usando pip (con --break-system-packages para entornos Alpine)
RUN pip install --no-cache-dir --break-system-packages google-genai beautifulsoup4 requests

# Copiar archivos de dependencias de Node
COPY package*.json ./

# Instalar dependencias de producción de Node
RUN npm ci --only=production

# Copiar el resto del código del proyecto
COPY . .

# Exponer el puerto del dashboard y webhook
EXPOSE 3000

# Iniciar servidor en producción
CMD ["npm", "start"]
