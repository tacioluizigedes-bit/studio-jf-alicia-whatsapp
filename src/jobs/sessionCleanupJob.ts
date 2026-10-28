import cron from 'node-cron';
import { SessionManager } from '../services/sessionManager';

let cronTask: any = null;

/**
 * Inicia a rotina agendada que faz a varredura e limpa sessões inativas há mais de 10 minutos (600.000 ms).
 * Executa a cada 1 minuto.
 */
export function startSessionCleanupJob(sessionManager: SessionManager) {
  console.log('⏱️ [JOB] Rotina de varredura e expiração de sessões inativas (10 min TTL) agendada (a cada 1 minuto).');

  cronTask = cron.schedule('* * * * *', async () => {
    try {
      await sessionManager.cleanupStaleSessions();
    } catch (error) {
      console.error('❌ [JOB] Erro ao executar varredura de varredura de sessões inativas:', error);
    }
  });

  return cronTask;
}
