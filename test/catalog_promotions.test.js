const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { handleOwnerCommands } = require('../dist/services/ownerControlService');
const { serviceCatalogService } = require('../dist/services/serviceCatalogService');
const { getSystemPrompt } = require('../dist/prompts/systemPrompt');
const { inferAppointmentDurationMinutes } = require('../dist/services/appointmentService');

function resetCatalog() {
  const p = path.resolve(process.cwd(), 'services.json');
  if (fs.existsSync(p)) {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.services = d.services.filter(
      s => !s.name.includes('Lash Lifting Especial') && !s.name.includes('Brow Lamination Teste')
    );
    const vol = d.services.find(s => s.id === 'cilios_volume_brasileiro');
    if (vol) {
      vol.price = 100;
      vol.durationMinutes = 120;
      delete vol.originalPrice;
      delete vol.isPromotional;
      delete vol.badge;
      delete vol.promotionalNote;
    }
    fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
  }
  serviceCatalogService.getAllServices();
}

describe('--- GESTÃO DE CATÁLOGO, PREÇOS E PROMOÇÕES PELA JANAÍNA ---', () => {

  before(() => {
    resetCatalog();
  });

  after(() => {
    resetCatalog();
  });

  it('1. Deve permitir que a Janaína altere o valor de um procedimento via WhatsApp', async () => {
    const cmd = 'Alterar valor do Volume Brasileiro para 95';
    const res = await handleOwnerCommands('5521993826303', cmd);

    assert.strictEqual(res.action, 'update_service_price');
    assert.match(res.reply, /Valor Atualizado com Sucesso, Jana/i);
    assert.match(res.reply, /95,00/);

    const srv = serviceCatalogService.findService('volume brasileiro');
    assert.ok(srv);
    assert.strictEqual(srv.price, 95);
  });

  it('2. Deve permitir que a Janaína coloque um procedimento em promoção com preço original salvo', async () => {
    const cmd = 'Promoção Volume Brasileiro por 80';
    const res = await handleOwnerCommands('5521993826303', cmd);

    assert.strictEqual(res.action, 'service_promotion');
    assert.match(res.reply, /Promoção Ativada com Sucesso, Jana/i);
    assert.match(res.reply, /80,00/);

    const srv = serviceCatalogService.findService('volume brasileiro');
    assert.ok(srv);
    assert.strictEqual(srv.price, 80);
    assert.strictEqual(srv.originalPrice, 95);
    assert.strictEqual(srv.isPromotional, true);

    // Verifica se getSystemPrompt() inclui a promoção ativa
    const prompt = getSystemPrompt();
    assert.match(prompt, /PROMOÇÕES ATIVAS/i);
    assert.match(prompt, /Volume Brasileiro/i);

    // Verifica se os serviços públicos incluem a oferta
    const publicList = serviceCatalogService.getPublicBookingServices();
    const publicVol = publicList.find(s => s.id === srv.id);
    assert.ok(publicVol);
    assert.strictEqual(publicVol.isPromotional, true);
    assert.strictEqual(publicVol.price, 80);
    assert.strictEqual(publicVol.originalPrice, 95);
    assert.strictEqual(publicVol.badge, '🔥 Promoção');
  });

  it('3. Deve listar as promoções ativas quando a Janaína consultar', async () => {
    const cmd = 'Ver promoções';
    const res = await handleOwnerCommands('5521993826303', cmd);

    assert.strictEqual(res.action, 'list_catalog');
    assert.match(res.reply, /Promoções Ativas/i);
    assert.match(res.reply, /Volume Brasileiro/i);
    assert.match(res.reply, /80,00/);
  });

  it('4. Deve permitir que a Janaína encerre uma promoção restaurando o preço anterior', async () => {
    const cmd = 'Tirar promoção do Volume Brasileiro';
    const res = await handleOwnerCommands('5521993826303', cmd);

    assert.strictEqual(res.action, 'service_promotion');
    assert.match(res.reply, /Promoção Encerrada com Sucesso/i);
    assert.match(res.reply, /95,00/);

    const srv = serviceCatalogService.findService('volume brasileiro');
    assert.ok(srv);
    assert.strictEqual(srv.price, 95);
    assert.strictEqual(srv.isPromotional, undefined);
  });

  it('5. Deve permitir que a Janaína cadastre um novo procedimento a qualquer momento', async () => {
    const cmd = 'Adicionar serviço Lash Lifting Especial, valor 115, duração 60 min';
    const res = await handleOwnerCommands('5521993826303', cmd);

    assert.strictEqual(res.action, 'add_custom_service');
    assert.match(res.reply, /Novo Procedimento Cadastrado com Sucesso/i);
    assert.match(res.reply, /Lash Lifting Especial/i);
    assert.match(res.reply, /115,00/);
    assert.match(res.reply, /60 min/);

    const srv = serviceCatalogService.findService('lash lifting especial');
    assert.ok(srv);
    assert.strictEqual(srv.price, 115);
    assert.strictEqual(srv.durationMinutes, 60);

    // O serviço agora deve constar na listagem de agendamento público
    const publicList = serviceCatalogService.getPublicBookingServices();
    const publicFound = publicList.find(s => s.name === 'Lash Lifting Especial');
    assert.ok(publicFound);
    assert.strictEqual(publicFound.priceDisplay, 'R$ 115,00');
  });

  it('6. Deve permitir editar tempo de execução, valor e promoção pelo Dashboard (updateServiceFull) e excluir (deleteService)', () => {
    // 1. Atualiza tempo de execução (durationMinutes) e valor do Volume Brasileiro pelo Dashboard
    const updateRes = serviceCatalogService.updateServiceFull('cilios_volume_brasileiro', {
      price: 110,
      durationMinutes: 90,
      isPromotional: true,
      originalPrice: 130,
      badge: '🔥 Super Oferta',
    });

    assert.strictEqual(updateRes.success, true);
    assert.ok(updateRes.service);
    assert.strictEqual(updateRes.service.price, 110);
    assert.strictEqual(updateRes.service.durationMinutes, 90);
    assert.strictEqual(updateRes.service.isPromotional, true);
    assert.strictEqual(updateRes.service.originalPrice, 130);

    // Verifica que inferAppointmentDurationMinutes agora reflete os 90 minutos configurados no Dashboard
    const inferredDur = inferAppointmentDurationMinutes(updateRes.service.name);
    assert.strictEqual(inferredDur, 90);

    // 2. Cria e remove um procedimento pelo Dashboard
    const addRes = serviceCatalogService.addCustomService({
      name: 'Brow Lamination Teste',
      price: 90,
      durationMinutes: 45,
      category: 'sobrancelhas',
    });
    assert.strictEqual(addRes.success, true);
    assert.ok(addRes.service);

    const delRes = serviceCatalogService.deleteService(addRes.service.id);
    assert.strictEqual(delRes.success, true);
    assert.strictEqual(serviceCatalogService.findService(addRes.service.id), undefined);
  });

  it('7. Deve extrair corretamente o nome da cliente e o procedimento mesmo com hífens, pontos ou datas no meio ("Marcar cliente dia 03 às 14hs - Fernanda limpeza de pele")', async () => {
    const { extractClientName, extractService } = require('../dist/services/nlpEntityExtractor');

    const msg1 = 'Marcar cliente dia 03 às 14hs - Fernanda limpeza de pele';
    assert.strictEqual(extractClientName(msg1), 'Fernanda');
    const srv1 = extractService(msg1);
    assert.ok(srv1);
    assert.strictEqual(srv1.name, 'Limpeza de Pele Profunda');
    assert.strictEqual(srv1.price, 120);

    const msg2 = 'Agendar uma cliente às 14hs hoje para depilação axila e virilha. Amanda';
    assert.strictEqual(extractClientName(msg2), 'Amanda');
    const srv2 = extractService(msg2);
    assert.ok(srv2);
    assert.match(srv2.name, /Combo Depilação: Axila \+ Virilha/i);
    assert.strictEqual(srv2.subServices.length, 2);

    const catalogRes = await handleOwnerCommands('5521993826303', 'Consultar tabela de valores de cílios');
    assert.strictEqual(catalogRes.action, 'list_catalog');
    assert.match(catalogRes.reply, /Tabela de Procedimentos e Valores/i);
    assert.match(catalogRes.reply, /Volume Brasileiro/i);
  });

  it('8. Deve criptografar (AES-256-GCM + GZIP) e descriptografar credenciais do Cofre na Nuvem perfeitamente', () => {
    const { encryptBuffer, decryptBuffer, getVaultStatus } = require('../dist/services/whatsappSessionVault');
    const sampleCreds = JSON.stringify({
      me: { id: '5521960003154:1@s.whatsapp.net', name: 'Studio JF Designer' },
      noiseKey: { private: 'abc', public: 'def' },
    });
    const encrypted = encryptBuffer(Buffer.from(sampleCreds, 'utf8'));
    assert.ok(encrypted.length > 20);

    const decrypted = decryptBuffer(encrypted).toString('utf8');
    assert.strictEqual(decrypted, sampleCreds);

    const st = getVaultStatus();
    assert.strictEqual(st.enabled, true);
    assert.strictEqual(st.repo, 'tacioluizigedes-bit/studio-jf-alicia-vault');
  });

  it('9. Deve permitir que a Janaína desmarque um atendimento informando apenas o horário e a data ("Desmarcar o horário das 14hs dia 03/11")', async () => {
    const { prisma } = require('../dist/lib/prisma');
    const testDate = new Date('2026-11-05T17:00:00.000Z'); // 05/11 às 14:00 BRT

    const created = await prisma.appointment.create({
      data: {
        clientName: 'Fernanda',
        whatsappPhone: '5521900000000',
        service: 'Limpeza de Pele Profunda',
        appointmentDate: testDate,
        totalAmount: 120,
        depositAmount: 0,
        depositStatus: 'EXEMPT',
        generalStatus: 'CONFIRMED',
        depositDeadline: testDate,
        isFirstAppointment: false,
      },
    });

    try {
      const cancelRes = await handleOwnerCommands('5521993826303', 'Desmarcar o horário das 14hs dia 05/11');
      assert.strictEqual(cancelRes.action, 'cancel_appointment');
      assert.match(cancelRes.reply, /Atendimento Desmarcado com Sucesso/i);
      assert.match(cancelRes.reply, /Fernanda/i);
      assert.match(cancelRes.reply, /Limpeza de Pele Profunda/i);
    } finally {
      await prisma.appointment.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  it('10. Deve suportar criação 1-tap, edição/remarcação, bloqueio/desbloqueio e CRM de clientes estilo MinhaAgenda', async () => {
    const { appointmentService } = require('../dist/services/appointmentService');
    const { prisma } = require('../dist/lib/prisma');

    // 1. Criar agendamento pelo painel MinhaAgenda
    const created = await appointmentService.createOwnerDashboardAppointment({
      clientName: 'Juliana Teste MinhaAgenda',
      whatsappPhone: '21988887777',
      serviceName: 'Colocação Volume Brasileiro',
      dateStr: '2026-11-06',
      timeStr: '10:00',
      durationMinutes: 90,
      totalAmount: 100,
      depositStatus: 'EXEMPT',
      notes: 'Criado na régua de 30 min'
    });
    assert.ok(created.id);
    assert.strictEqual(created.clientName, 'Juliana Teste MinhaAgenda');

    // 2. Editar / remarcar agendamento para 11:00
    const edited = await appointmentService.editOwnerDashboardAppointment(created.id, {
      timeStr: '11:00',
      dateStr: '2026-11-06',
      totalAmount: 110,
      serviceName: 'Colocação Volume Egípcio'
    });
    assert.strictEqual(edited.totalAmount, 110);
    assert.strictEqual(edited.service, 'Colocação Volume Egípcio');

    // 3. Criar bloqueio na régua e depois liberar
    const block = await appointmentService.createBlockedSlotFromDashboard({
      dateStr: '2026-11-06',
      startTimeStr: '15:00',
      endTimeStr: '16:30',
      reason: 'Consulta Médica Teste'
    });
    assert.ok(block.id);

    // 4. Verificar que getWeeklyDashboard retorna dateKey, startTimeStr e endTimeStr
    const dash = await appointmentService.getWeeklyDashboard('2026-11-02', '2026-11-08');
    const foundAppt = dash.schedule.find(s => s.id === created.id);
    assert.ok(foundAppt);
    assert.strictEqual(foundAppt.dateKey, '2026-11-06');
    assert.strictEqual(foundAppt.startTimeStr, '11:00');

    // 5. Verificar CRM de clientes
    const clientsRes = await appointmentService.getClientsCrmList();
    assert.ok(Array.isArray(clientsRes.clients));
    assert.ok(clientsRes.clients.some(c => c.name === 'Juliana Teste MinhaAgenda'));

    // 6. Liberar bloqueio e limpar agendamento de teste
    await appointmentService.deleteBlockedSlotFromDashboard(`block-${block.id}`);
    await prisma.appointment.delete({ where: { id: created.id } }).catch(() => {});
  });

});
