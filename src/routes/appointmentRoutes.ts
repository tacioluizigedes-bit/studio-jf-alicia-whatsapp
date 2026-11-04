import { Router, Request, Response } from 'express';
import { AppointmentService, WebhookAliciaSchema } from '../services/appointmentService';
import { ZodError } from 'zod';
import { triggerWeeklyReportNow } from '../jobs/weeklyReportJob';
import { process24hReminders } from '../jobs/reminderJob';
import { buildWeeklyReportMessage } from '../services/notificationService';
import { serviceCatalogService } from '../services/serviceCatalogService';
import { scheduleDatabaseVaultBackup } from '../services/whatsappSessionVault';
import { getSyncedWhatsAppContacts } from '../services/whatsappConnection';

export const appointmentRouter = Router();
const appointmentService = new AppointmentService();

/**
 * POST /api/appointments/webhook-alicia
 * Rota de ingestão de pré-agendamentos da atendente Alícia com cálculo/isenção de sinal.
 */
appointmentRouter.post('/webhook-alicia', async (req: Request, res: Response) => {
  try {
    const result = await appointmentService.createAliciaAppointment(req.body);
    scheduleDatabaseVaultBackup();
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
    scheduleDatabaseVaultBackup();
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
    scheduleDatabaseVaultBackup();
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
    scheduleDatabaseVaultBackup();
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
    scheduleDatabaseVaultBackup();
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
 * DELETE /api/appointments/:id
 * Exclusão definitiva de agendamento (ex: duplicado ou cancelado).
 */
appointmentRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await appointmentService.deleteAppointment(id);
    scheduleDatabaseVaultBackup();
    return res.json(result);
  } catch (error: any) {
    console.error(`Erro ao excluir agendamento ${req.params.id}:`, error);
    const statusCode = error?.message?.includes('não encontrado') ? 404 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error?.message || 'Erro ao excluir agendamento.',
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

/**
 * ============================================================================
 * GESTÃO DO CATÁLOGO DE PROCEDIMENTOS PELO DASHBOARD DA JANAÍNA
 * ============================================================================
 */

/**
 * GET /api/dashboard/services (ou /api/appointments/services)
 * Lista todos os procedimentos cadastrados com duração, valores e status promocional.
 */
appointmentRouter.get('/services', (_req: Request, res: Response) => {
  try {
    const services = serviceCatalogService.getAllServices();
    const publicServices = serviceCatalogService.getPublicBookingServices();
    return res.json({
      success: true,
      services,
      publicServices,
    });
  } catch (error: any) {
    console.error('Erro ao listar procedimentos no dashboard:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro ao carregar procedimentos.',
    });
  }
});

/**
 * POST /api/dashboard/services
 * Cadastra um novo procedimento no catálogo.
 */
appointmentRouter.post('/services', (req: Request, res: Response) => {
  try {
    const { name, price, durationMinutes, category, description, badge, isPromotional, originalPrice } = req.body || {};
    if (!name || price === undefined || isNaN(Number(price))) {
      return res.status(400).json({
        success: false,
        error: 'Nome e valor do procedimento são obrigatórios.',
      });
    }

    const result = serviceCatalogService.addCustomService({
      name: String(name),
      price: Number(price),
      durationMinutes: durationMinutes ? Number(durationMinutes) : 60,
      category: category ? String(category) : undefined,
      description: description ? String(description) : undefined,
      badge: badge ? String(badge) : undefined,
      isPromotional: !!isPromotional,
      originalPrice: originalPrice ? Number(originalPrice) : undefined,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.message || 'Não foi possível adicionar o procedimento.',
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Procedimento cadastrado com sucesso!',
      service: result.service,
      services: serviceCatalogService.getAllServices(),
    });
  } catch (error: any) {
    console.error('Erro ao criar procedimento no dashboard:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro interno ao cadastrar procedimento.',
    });
  }
});

/**
 * PUT / PATCH /api/dashboard/services/:id
 * Atualiza tempo de execução, valor, nome, categoria, promoção ou descrição de um procedimento.
 */
const handleUpdateService = (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, price, durationMinutes, category, description, isPromotional, originalPrice, badge } = req.body || {};

    const result = serviceCatalogService.updateServiceFull(id, {
      name,
      price: price !== undefined ? Number(price) : undefined,
      durationMinutes: durationMinutes !== undefined ? Number(durationMinutes) : undefined,
      category,
      description,
      isPromotional: typeof isPromotional === 'boolean' ? isPromotional : undefined,
      originalPrice: originalPrice !== undefined ? Number(originalPrice) : undefined,
      badge,
    });

    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.message || 'Procedimento não encontrado.',
      });
    }

    return res.json({
      success: true,
      message: `Procedimento "${result.service?.name}" atualizado com sucesso!`,
      service: result.service,
      services: serviceCatalogService.getAllServices(),
    });
  } catch (error: any) {
    console.error(`Erro ao atualizar procedimento ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro interno ao atualizar procedimento.',
    });
  }
};

appointmentRouter.put('/services/:id', handleUpdateService);
appointmentRouter.patch('/services/:id', handleUpdateService);

/**
 * DELETE /api/dashboard/services/:id
 * Remove um procedimento do catálogo.
 */
appointmentRouter.delete('/services/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = serviceCatalogService.deleteService(id);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.message || 'Procedimento não encontrado.',
      });
    }

    return res.json({
      success: true,
      message: `Procedimento "${result.deletedService?.name}" removido com sucesso!`,
      deletedService: result.deletedService,
      services: serviceCatalogService.getAllServices(),
    });
  } catch (error: any) {
    console.error(`Erro ao remover procedimento ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro interno ao remover procedimento.',
    });
  }
});

/**
 * POST /api/dashboard/owner-create (e /api/appointments/owner-create)
 * Cria agendamento diretamente pelo painel MinhaAgenda da Janaína (toque em horário vago ou botão +)
 */
appointmentRouter.post('/owner-create', async (req: Request, res: Response) => {
  try {
    const result = await appointmentService.createOwnerDashboardAppointment(req.body || {});
    scheduleDatabaseVaultBackup();
    return res.status(201).json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao criar agendamento.',
    });
  }
});

/**
 * PATCH /api/dashboard/:id/edit (e /api/appointments/:id/edit)
 * Edição completa de agendamento (trocar horário, data, procedimento, valor ou status)
 */
appointmentRouter.patch('/:id/edit', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await appointmentService.editOwnerDashboardAppointment(id, req.body || {});
    scheduleDatabaseVaultBackup();
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao editar agendamento.',
    });
  }
});

/**
 * POST /api/dashboard/blocks (e /api/appointments/blocks)
 * Bloqueia horário ou dia inteiro diretamente pela régua do MinhaAgenda
 */
appointmentRouter.post('/blocks', async (req: Request, res: Response) => {
  try {
    const result = await appointmentService.createBlockedSlotFromDashboard(req.body || {});
    scheduleDatabaseVaultBackup();
    return res.status(201).json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao bloquear horário.',
    });
  }
});

/**
 * DELETE /api/dashboard/blocks/:id (e /api/appointments/blocks/:id)
 * Desbloqueia / libera horário bloqueado na régua do MinhaAgenda
 */
appointmentRouter.delete('/blocks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await appointmentService.deleteBlockedSlotFromDashboard(id);
    scheduleDatabaseVaultBackup();
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao liberar bloqueio.',
    });
  }
});

/**
 * GET /api/dashboard/clients (e /api/appointments/clients)
 * Lista CRM de clientes atendidas com histórico, recorrência e total investido
 */
appointmentRouter.get('/clients', async (req: Request, res: Response) => {
  try {
    const result = await appointmentService.getClientsCrmList();
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro ao carregar lista de clientes.',
    });
  }
});

/**
 * PATCH /api/dashboard/:id/toggle-payment (e /api/appointments/:id/toggle-payment)
 * Dá baixa ou reabre o pagamento de um atendimento na tela de Cobranças (MinhaAgenda)
 */
appointmentRouter.patch('/:id/toggle-payment', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { forcePaid } = req.body || {};
    const result = await appointmentService.toggleAppointmentPaidStatus(id, forcePaid);
    scheduleDatabaseVaultBackup();
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao atualizar status de pagamento.',
    });
  }
});

/**
 * POST /api/dashboard/clients/notes (e /api/appointments/clients/notes)
 * Salva anotações / ficha de anamnese na ficha da cliente
 */
appointmentRouter.post('/clients/notes', async (req: Request, res: Response) => {
  try {
    const { clientName, noteText } = req.body || {};
    const result = await appointmentService.saveClientProfileNote(clientName, noteText);
    scheduleDatabaseVaultBackup();
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'Erro ao salvar anotações da cliente.',
    });
  }
});

/**
 * GET /api/dashboard/clients/whatsapp-contacts (e /api/appointments/clients/whatsapp-contacts)
 * Retorna contatos sincronizados pelo WhatsApp conectado (Baileys)
 */
appointmentRouter.get('/clients/whatsapp-contacts', async (_req: Request, res: Response) => {
  try {
    const contacts = getSyncedWhatsAppContacts();
    return res.json({
      success: true,
      count: contacts.length,
      contacts,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro ao carregar contatos do WhatsApp.',
    });
  }
});

/**
 * POST /api/dashboard/clients/import-contacts (e /api/appointments/clients/import-contacts)
 * Importa contatos selecionados no celular ou do WhatsApp para a base de clientes do Studio
 */
appointmentRouter.post('/clients/import-contacts', async (req: Request, res: Response) => {
  try {
    const { contacts } = req.body || {};
    if (!contacts || !Array.isArray(contacts)) {
      return res.status(400).json({
        success: false,
        error: 'Nenhum contato informado para importação.',
      });
    }

    const result = await appointmentService.importContactsBatch(contacts);
    scheduleDatabaseVaultBackup();
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro ao importar contatos.',
    });
  }
});

