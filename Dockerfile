FROM node:22-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción (omite dependencias de desarrollo y acelera la compilación)
RUN npm ci --only=production

# Copiar el resto del código del proyecto
COPY . .

# Exponer el puerto del dashboard y webhook
EXPOSE 3000

# Iniciar servidor en producción
CMD ["npm", "start"]
