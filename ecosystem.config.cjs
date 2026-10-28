/**
 * ecosystem.config.cjs
 * Configuração do PM2 para manter o agente Alícia online 24/7 em VPS Linux ou Windows
 * Uso:
 *   npm run build
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'studio-jf-alicia',
      script: './dist/index.js',
      instances: 1, // Importante: manter 1 instância única para não duplicar a conexão WebSocket do Baileys
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      restart_delay: 4000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        STUDIO_OFFICIAL_NUMBER: '5521960003154',
        OWNER_PERSONAL_NUMBER: '5521993826303',
        STUDIO_PIX_KEY: '21960003154',
      },
    },
  ],
};
