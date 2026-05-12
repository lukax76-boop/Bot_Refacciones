FROM node:20-bullseye-slim

WORKDIR /app

# Instalar Chromium y las librerías del sistema que necesita Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Variables para decirle a Puppeteer dónde está Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copiar e instalar
COPY package*.json ./
RUN npm install

# Copiar el resto del proyecto
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
