import cron from 'node-cron';
import { AppointmentService } from '../services/appointmentService';

const appointmentService = new AppointmentService();

/**
 * Inicia a rotina agendada (Cron Job) que verifica e cancela agendamentos com prazo de sinal expirado.
 * Executa a cada 1 minuto.
 */
export function startExpirationJob() {
  console.log('⏱️ [JOB] Rotina de verificação de expiração de sinais agendada (a cada 1 minuto).');

  cron.schedule('* * * * *', async () => {
    try {
      const result = await appointmentService.expirePendingDeposits();
      if (result.expiredCount > 0) {
        console.log(`🧹 [JOB] ${result.expiredCount} agendamento(s) com sinal expirado foram cancelados automaticamente.`);
      }
    } catch (error) {
      console.error('❌ [JOB] Erro ao executar rotina de expiração de sinais:', error);
    }
  });
}
