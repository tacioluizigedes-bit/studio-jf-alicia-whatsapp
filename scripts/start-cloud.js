const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function bootstrapCloud() {
  // 1. Garante diretório persistente na nuvem (/data) caso configurado
  const dbUrl = process.env.DATABASE_URL || 'file:./dev.db';
  if (dbUrl.startsWith('file:/data/')) {
    const dataDir = '/data';
    const targetDb = dbUrl.replace('file:', '');
    const seedDb = fs.existsSync(path.resolve(__dirname, '..', 'prisma', 'seed-agenda.db'))
      ? path.resolve(__dirname, '..', 'prisma', 'seed-agenda.db')
      : path.resolve(__dirname, '..', 'prisma', 'dev.db');

    fs.mkdirSync(dataDir, { recursive: true });

    // Tenta restaurar o banco mais recente salvo no Cofre da Nuvem 24/7
    if (!fs.existsSync(targetDb)) {
      try {
        const vaultModPath = path.resolve(__dirname, '..', 'dist', 'services', 'whatsappSessionVault.js');
        if (fs.existsSync(vaultModPath)) {
          const { restoreDatabaseFromVault } = require(vaultModPath);
          await restoreDatabaseFromVault(targetDb);
        }
      } catch (err) {
        console.warn('⚠️ Aviso ao consultar cofre de banco na nuvem:', err.message);
      }
    }

    // Se ainda não existir no volume persistente, copia o banco inicial (agenda da Janaína)
    if (!fs.existsSync(targetDb) && fs.existsSync(seedDb)) {
      fs.copyFileSync(seedDb, targetDb);
      console.log('📦 [CLOUD INIT] Banco de dados inicial (agenda da Janaína) copiado para ' + targetDb);
    }
  }

  const baileysDir = process.env.BAILEYS_AUTH_DIR;
  if (baileysDir) {
    fs.mkdirSync(baileysDir, { recursive: true });
  }

  // 2. Sincroniza schema Prisma sem perder dados
  try {
    execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠️ Aviso ao executar prisma db push:', err.message);
  }

  // 2.1 Higieniza registros legados ("Cliente (Agendada pela Janaína)" / "Procedimento Studio JF")
  try {
    execSync('node scripts/fix-db-records.js', { stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠️ Aviso ao higienizar registros legados:', err.message);
  }

  // 3. Inicia o servidor principal 24/7
  require('../dist/index.js');
}

bootstrapCloud();

