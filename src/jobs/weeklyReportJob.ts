import cron from 'node-cron';
import { AppointmentService } from '../services/appointmentService';
import { notifyOwnerWeeklyReport, WeeklyOwnerReportData } from '../services/notificationService';
import { SALON_CONFIG } from '../config/salonConfig';

const appointmentService = new AppointmentService();

/**
 * Executa a lógica de extração dos dados e envio do relatório semanal para a proprietária.
 */
export async function executeWeeklyReport(referenceDate?: Date): Promise<{
  success: boolean;
  message: string;
  reportData: WeeklyOwnerReportData;
}> {
  console.log('📊 [JOB RESUMO SEMANAL] Iniciando compilação do relatório semanal para a gestora...');

  const reportData = await appointmentService.getWeeklyOwnerReportData(referenceDate);

  const sent = await notifyOwnerWeeklyReport(reportData);

  if (sent) {
    console.log('✅ [JOB RESUMO SEMANAL] Relatório semanal enviado com sucesso para a proprietária!');
    return {
      success: true,
      message: 'Relatório semanal enviado com sucesso para o WhatsApp da proprietária.',
      reportData,
    };
  } else {
    console.warn('⚠️ [JOB RESUMO SEMANAL] O relatório foi compilado, mas houve falha no envio via WhatsApp.');
    return {
      success: false,
      message: 'Relatório semanal compilado, mas falhou ao enviar via WhatsApp.',
      reportData,
    };
  }
}

/**
 * REQUISITO 2:
 * Inicia o agendador de tarefas (Cron Job) que dispara o relatório/resumo semanal
 * todo domingo às 20h00 (horário de Brasília / America/Sao_Paulo).
 * Expressão cron: '0 20 * * 0'
 */
export function startWeeklyReportJob() {
  const cronExpression = '0 20 * * 0'; // Todo domingo às 20:00
  const timezone = SALON_CONFIG.timezone || 'America/Sao_Paulo';

  console.log(`⏱️ [JOB] Resumo Semanal dos Domingos agendado ('${cronExpression}') no fuso ${timezone}.`);

  cron.schedule(
    cronExpression,
    async () => {
      console.log('⏰ [JOB CRON DOMINGO 20H] Disparo automático do Resumo Semanal do Studio JF Designer.');
      try {
        await executeWeeklyReport();
      } catch (error) {
        console.error('❌ [JOB CRON DOMINGO 20H] Erro fatal na rotina do resumo semanal:', error);
      }
    },
    {
      timezone,
    }
  );
}

/**
 * Função utilitária para disparo manual/imediato do relatório semanal (via API/Testes).
 */
export async function triggerWeeklyReportNow(referenceDate?: Date) {
  return await executeWeeklyReport(referenceDate);
}
