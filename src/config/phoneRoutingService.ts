/**
 * phoneRoutingService.ts
 * Configuração e resolução de papéis de canais WhatsApp e chaves oficiais do Studio JF Designer.
 */

export const CONFIG = {
  OFFICIAL_STUDIO_PHONE: '5521960003154',
  OWNER_PERSONAL_PHONE: '5521993826303',
  PIX_KEY: '21960003154',
};

/**
 * Sanitiza um número de telefone mantendo apenas dígitos
 */
export function normalizePhoneDigits(phone?: string | null): string {
  if (!phone) return '';
  return phone.toString().replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');
}

/**
 * Resolve o papel do remetente com base no número de origem:
 * - '5521993826303' / '21993826303' -> 'OWNER' (Janaína Ferreira)
 * - Qualquer outro número externo -> 'CLIENT'
 */
export function resolveSenderRole(phone?: string | null): 'OWNER' | 'CLIENT' {
  const clean = normalizePhoneDigits(phone);
  const ownerClean = normalizePhoneDigits(CONFIG.OWNER_PERSONAL_PHONE); // 5521993826303
  if (!clean) return 'CLIENT';

  if (
    clean === ownerClean ||
    clean === '21993826303' ||
    clean.endsWith('21993826303')
  ) {
    return 'OWNER';
  }

  return 'CLIENT';
}

export default {
  CONFIG,
  resolveSenderRole,
  normalizePhoneDigits,
};
