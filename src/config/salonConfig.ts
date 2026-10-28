import servicesData from '../../services.json';

export const SALON_CONFIG = {
  name: servicesData.establishment.name,
  assistantName: (servicesData.establishment as any).assistantName || 'Alícia',
  ownerName: servicesData.establishment.ownerName,
  ownerPhone: process.env.STUDIO_OWNER_WHATSAPP || process.env.SALON_OWNER_WHATSAPP || '5521993826303',
  officialNumber: process.env.STUDIO_OFFICIAL_NUMBER || '5521960003154',
  ownerPersonalNumber: process.env.OWNER_PERSONAL_NUMBER || '5521993826303',
  pixKey: process.env.STUDIO_PIX_KEY || (servicesData.establishment as any).pixKey || '21960003154',
  instagram: servicesData.establishment.instagram,
  address: servicesData.establishment.address,
  timezone: servicesData.establishment.timezone,
  rules: servicesData.establishment.rules,
  businessHours: servicesData.businessHours,
  services: servicesData.services
};
