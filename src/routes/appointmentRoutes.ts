import { Router, Request, Response } from 'express';
import { AppointmentService, WebhookAliciaSchema } from '../services/appointmentService';
import { ZodError } from 'zod';
import { triggerWeeklyReportNow } from '../jobs/weeklyReportJob';
import { process24hReminders } from '../jobs/reminderJob';
import { buildWeeklyReportMessage } from '../services/notificationService';

export const appointmentRouter = Router();
const appointmentService = new AppointmentService();

/**
 * POST /api/appointments/webhook-alicia
 * Rota de ingestão de pré-agendamentos da atendente Alícia com cálculo/isenção de sinal.
 */
appointmentRouter.post('/webhook-alicia', async (req: Request, res: Response) => {
  try {
    const result = await appointmentService.createAliciaAppointment(req.body);
    return res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Erro de validação nos dados do agendamento.',
        details: error.issues.map((err: any) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    console.error('Erro ao processar webhook da Alícia:', error);
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro interno ao processar agendamento.',
    });
  }
});

/**
 * POST /api/appointments/:id/reschedule
 * Rota de solicitação de remarcação com aplicação de política de 24h.
 */
appointmentRouter.post('/:id/reschedule', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { newDate, durationMinutes } = req.body;

    if (!newDate) {
      return res.status(400).json({ success: false, error: 'Parâmetro "newDate" é obrigatório.' });
    }

    const result = await appointmentService.requestReschedule(id, newDate, durationMinutes);
    return res.json(result);
  } catch (error: any) {
    console.error(`Erro ao remarcar agendamento ${req.params.id}:`, error);
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao processar remarcação.',
    });
  }
});

/**
 * PATCH /api/appointments/:id/confirm-deposit
 * Confirmação manual de sinal pelos operadores.
 */
appointmentRouter.patch('/:id/confirm-deposit', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { confirmedBy = 'Operador', notes } = req.body;

    const result = await appointmentService.confirmDeposit(id, confirmedBy, notes);
    return res.json(result);
  } catch (error: any) {
    console.error(`Erro ao confirmar sinal do agendamento ${req.params.id}:`, error);
    const statusCode = error?.message?.includes('não encontrado') ? 404 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error?.message || 'Erro ao confirmar sinal.',
    });
  }
});

/**
 * PATCH /api/appointments/:id/receipt
 * Marcação de envio de comprovante pela cliente.
 */
appointmentRouter.patch('/:id/receipt', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const result = await appointmentService.markReceiptSent(id, notes);
    return res.json(result);
  } catch (error: any) {
    console.error(`Erro ao registrar comprovante do agendamento ${req.params.id}:`, error);
    const statusCode = error?.message?.includes('não encontrado') ? 404 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error?.message || 'Erro ao registrar envio de comprovante.',
    });
  }
});

/**
 * PATCH /api/appointments/:id/cancel
 * Cancelamento manual de horário.
 */
appointmentRouter.patch('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await appointmentService.cancelAppointment(id, reason);
    return res.json(result);
  } catch (error: any) {
    console.error(`Erro ao cancelar agendamento ${req.params.id}:`, error);
    const statusCode = error?.message?.includes('não encontrado') ? 404 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error?.message || 'Erro ao cancelar agendamento.',
    });
  }
});

/**
 * GET /api/dashboard/weekly
 * Retorna dados agregados com metrics e schedule para renderização completa do dashboard semanal.
 */
appointmentRouter.get('/dashboard/weekly', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, status } = req.query as {
      startDate?: string;
      endDate?: string;
      status?: string;
    };

    const dashboard = await appointmentService.getWeeklyDashboard(startDate, endDate, status);
    return res.json({
      period: dashboard.period,
      metrics: dashboard.metrics,
      schedule: dashboard.schedule,
      appointments: dashboard.schedule,
    });
  } catch (error: any) {
    console.error('Erro ao buscar dados do dashboard semanal:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao gerar dados do dashboard semanal.',
      message: error?.message,
    });
  }
});

/**
 * GET /api/appointments/weekly (Alias para o frontend)
 */
appointmentRouter.get('/weekly', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, status } = req.query as {
      startDate?: string;
      endDate?: string;
      status?: string;
    };

    const dashboard = await appointmentService.getWeeklyDashboard(startDate, endDate, status);
    return res.json({
      period: dashboard.period,
      metrics: dashboard.metrics,
      schedule: dashboard.schedule,
      appointments: dashboard.schedule,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * GET /api/appointments/metrics/weekly (Alias para o frontend)
 */
appointmentRouter.get('/metrics/weekly', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query as {
      startDate?: string;
      endDate?: string;
    };

    const dashboard = await appointmentService.getWeeklyDashboard(startDate, endDate);
    return res.json({
      period: dashboard.period,
      metrics: dashboard.metrics,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/appointments/trigger-24h-reminders
 * Disparo sob demanda da rotina de lembretes de 24h.
 */
appointmentRouter.post('/trigger-24h-reminders', async (req: Request, res: Response) => {
  try {
    const result = await process24hReminders();
    return res.json({
      success: true,
      message: `Rotina de lembrete 24h executada. ${result.processedCount} lembrete(s) processado(s).`,
      result,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/appointments/trigger-weekly-report
 * Disparo imediato sob demanda do Relatório Semanal para a proprietária.
 */
appointmentRouter.post('/trigger-weekly-report', async (req: Request, res: Response) => {
  try {
    const { date } = req.body || {};
    const refDate = date ? new Date(date) : undefined;
    const result = await triggerWeeklyReportNow(refDate);
    const messagePreview = buildWeeklyReportMessage(result.reportData);

    return res.json({
      ...result,
      messagePreview,
    });
  } catch (error: any) {
    console.error('Erro ao disparar relatório semanal para proprietária:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao disparar relatório semanal.',
      message: error?.message,
    });
  }
});

/**
 * GET /api/appointments/weekly-owner-report-preview
 * Prévia dos dados analíticos e do texto formatado do WhatsApp do resumo semanal.
 */
appointmentRouter.get('/weekly-owner-report-preview', async (req: Request, res: Response) => {
  try {
    const { date } = req.query as { date?: string };
    const refDate = date ? new Date(date) : undefined;
    const reportData = await appointmentService.getWeeklyOwnerReportData(refDate);
    const messagePreview = buildWeeklyReportMessage(reportData);

    return res.json({
      success: true,
      reportData,
      messagePreview,
    });
  } catch (error: any) {
    console.error('Erro ao gerar prévia do relatório semanal:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao gerar prévia do relatório semanal.',
      message: error?.message,
    });
  }
});
