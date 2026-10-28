# Dockerfile para produção 24/7 (Railway / Render / Fly.io / VPS Docker)
FROM node:22-bookworm-slim

# Instala OpenSSL necessário para o Prisma Engine e certificados HTTPS/WSS
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia manifestos de pacotes e schema do Prisma
COPY package*.json ./
COPY prisma ./prisma/

# Instala dependências e gera o Prisma Client
RUN npm install
RUN npx prisma generate

# Copia o restante do código-fonte e configurações
COPY . .

# Compila o TypeScript para dist/ e copia as views HTML
RUN npm run build

# Cria diretório persistente padrão para banco SQLite e sessão do Baileys
RUN mkdir -p /data/auth_info_baileys

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Garante criação das tabelas SQLite no volume e inicia o servidor
CMD ["npm", "run", "start:prod"]
