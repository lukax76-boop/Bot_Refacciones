FROM ghcr.io/puppeteer/puppeteer:latest

# Cambiar al usuario root temporalmente para copiar archivos e instalar
USER root

# Variables de entorno cruciales para Puppeteer en Docker
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Copiar configuración de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el código del proyecto
COPY . .

# Dar permisos al usuario seguro de puppeteer para que pueda escribir en auth/cache
RUN chown -R pptruser:pptruser /app

# Volver al usuario de menores privilegios por seguridad
USER pptruser

EXPOSE 3000

CMD ["npm", "start"]
