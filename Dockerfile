FROM ghcr.io/puppeteer/puppeteer:latest

# Necesitamos ser root temporalmente para instalar cosas
USER root

# Crear directorio de la app
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
