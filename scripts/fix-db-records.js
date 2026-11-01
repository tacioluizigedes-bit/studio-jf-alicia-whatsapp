const fs = require('fs');
const path = require('path');
const { PrismaClient, Prisma } = require('@prisma/client');

async function sanitizeDb(dbUrl) {
  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  try {
    const all = await prisma.appointment.findMany({
      orderBy: { appointmentDate: 'asc' },
    });

    for (const apt of all) {
      // 1. Remove duplicate placeholder rows where another real appointment exists at the same time
      if (
        (apt.clientName === 'Cliente (Agendada pela Janaína)' || apt.clientName === 'Cliente') &&
        apt.service === 'Procedimento Studio JF'
      ) {
        const sameTimeOthers = all.filter(
          (other) =>
            other.id !== apt.id &&
            other.appointmentDate.getTime() === apt.appointmentDate.getTime()
        );
        if (sameTimeOthers.length > 0) {
          await prisma.appointment.delete({ where: { id: apt.id } });
          console.log(`🧹 [DB CLEANUP] Removido registro duplicado ${apt.id} em ${apt.appointmentDate.toISOString()}`);
          continue;
        }
      }

      let newClientName = (apt.clientName || '').replace(/\s+(?:às|as|para|no|na)$/i, '').trim();
      let newService = apt.service;
      let newTotal = Number(apt.totalAmount);

      const iso = apt.appointmentDate.toISOString();
      if (iso === '2026-11-03T17:00:00.000Z' && (/^cliente/i.test(newClientName) || /studio\s*jf/i.test(newService))) {
        newClientName = 'Fernanda';
        newService = 'Limpeza de Pele Profunda';
        newTotal = 120;
      } else if (iso === '2026-10-27T21:00:00.000Z' && newClientName === 'Renata' && /studio\s*jf/i.test(newService)) {
        newService = 'Manutenção Cílios Volume Brasileiro';
        newTotal = 65;
      } else if (iso === '2026-10-28T17:00:00.000Z' && /^cliente/i.test(newClientName) && /virilha/i.test(newService)) {
        newClientName = 'Amanda';
      } else if (iso === '2026-10-28T19:00:00.000Z' && /^cliente/i.test(newClientName)) {
        newClientName = 'Carla Mendes';
        if (/studio\s*jf/i.test(newService)) {
          newService = 'Colocação Cílios Volume Brasileiro';
          newTotal = 100;
        }
      } else if (iso === '2026-10-30T13:00:00.000Z' && /^cliente/i.test(newClientName)) {
        newClientName = 'Bruna Oliveira';
      } else {
        if (/studio\s*jf|procedimento\s*studio/i.test(newService)) {
          newService = 'Design de Sobrancelha';
          if (newTotal === 60) newTotal = 25;
        }
        if (/^cliente\s*\(agendada pela jana[ií]na\)$/i.test(newClientName) || /^cliente$/i.test(newClientName)) {
          newClientName = 'Fernanda';
        }
      }

      if (
        newClientName !== apt.clientName ||
        newService !== apt.service ||
        newTotal !== Number(apt.totalAmount)
      ) {
        await prisma.appointment.update({
          where: { id: apt.id },
          data: {
            clientName: newClientName,
            service: newService,
            totalAmount: new Prisma.Decimal(newTotal),
          },
        });
        console.log(
          `🧹 [DB CLEANUP] Atualizado ${apt.id} (${iso}): "${apt.clientName}" -> "${newClientName}", "${apt.service}" -> "${newService}"`
        );
      }
    }

    // Garante que o agendamento da Fernanda (03/11/2026 às 14:00 - Limpeza de Pele Profunda) esteja registrado
    const fernandaDate = new Date('2026-11-03T17:00:00.000Z');
    const existingFernanda = await prisma.appointment.findFirst({
      where: {
        appointmentDate: fernandaDate,
        generalStatus: { not: 'CANCELLED' },
      },
    });
    if (!existingFernanda) {
      await prisma.appointment.create({
        data: {
          clientName: 'Fernanda',
          whatsappPhone: '5521900000000',
          service: 'Limpeza de Pele Profunda',
          appointmentDate: fernandaDate,
          totalAmount: new Prisma.Decimal(120),
          depositAmount: new Prisma.Decimal(0),
          depositStatus: 'EXEMPT',
          generalStatus: 'CONFIRMED',
          depositDeadline: new Date('2026-11-03T19:00:00.000Z'),
          confirmedAt: new Date(),
          confirmedBy: 'Janaína (Direto)',
          isFirstAppointment: false,
          notes: '[Agendado diretamente pela Janaína]',
        },
      });
      console.log(`🧹 [DB CLEANUP] Agendamento confirmado: Fernanda em 03/11/2026 às 14:00 (Limpeza de Pele Profunda - R$ 120,00)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function run() {
  const targets = new Set();
  if (process.env.DATABASE_URL) {
    targets.add(process.env.DATABASE_URL);
  }
  const localDev = path.resolve(__dirname, '..', 'prisma', 'dev.db');
  if (fs.existsSync(localDev)) {
    targets.add('file:./dev.db');
  }
  const seedDb = path.resolve(__dirname, '..', 'prisma', 'seed-agenda.db');
  if (fs.existsSync(seedDb)) {
    targets.add('file:./seed-agenda.db');
  }

  for (const url of targets) {
    try {
      await sanitizeDb(url);
    } catch (err) {
      console.warn(`⚠️ [DB CLEANUP] Aviso em ${url}:`, err.message);
    }
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { sanitizeDb, run };
