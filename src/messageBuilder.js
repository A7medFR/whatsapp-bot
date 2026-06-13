/**
 * messageBuilder.js
 * Formats offer data into WhatsApp messages (Arabic, professional clinic style).
 */

'use strict';

const CLINIC_NAME = 'عيادتنا الطبية';

/**
 * Build the greeting message (sent once before all offers).
 * @param {string} phone
 */
function buildGreeting() {
  return (
    `مرحباً بك! 👋\n\n` +
    `نود مشاركتك بأحدث عروضنا الحصرية من ${CLINIC_NAME}.\n` +
    `يسعدنا تقديم أفضل الخدمات الطبية بأسعار مميزة 🏥`
  );
}

/**
 * Build the image caption for a single offer (shown with the image).
 * @param {object} offer - { title, department }
 */
function buildImageCaption(offer) {
  const dept = offer.department ? `\n📂 ${offer.department}` : '';
  return `✨ *${offer.title}*${dept}\n🏥 ${CLINIC_NAME}`;
}

/**
 * Build the services/pricing text for a single offer (sent after the image).
 * @param {object} offer - { title, services: [{ option, price_after }] }
 */
function buildServicesText(offer) {
  const lines = [`📋 *تفاصيل عرض: ${offer.title}*`, `━━━━━━━━━━━━━━━━━━━━`];

  const services = Array.isArray(offer.services) ? offer.services : [];
  let hasDiscountedPrice = false;

  if (services.length === 0) {
    lines.push('   يرجى التواصل معنا للاستفسار عن التفاصيل.');
  } else {
    for (const svc of services) {
      if (svc.price_after !== undefined && svc.price_after !== null && svc.price_after !== '') {
        hasDiscountedPrice = true;
        lines.push(`   • ${svc.option}`);
      } else {
        const price = Number(svc.price_after_tax ?? svc.price ?? svc.price_before_tax ?? 0);
        const priceStr = price > 0 ? `${price.toLocaleString('ar-SA')} ريال` : 'السعر عند الاستفسار';
        lines.push(`   • ${svc.option}  ←  ${priceStr}`);
      }
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  if (hasDiscountedPrice) {
    lines.push(`🎁 العرض يشمل خصم 7%!`);
  } else {
    lines.push(`✅ جميع الأسعار شاملة الضريبة`);
  }

  return lines.join('\n');
}

/**
 * Build the final CTA message (sent once after all offers).
 */
function buildCTA() {
  return (
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `هل ترغب في الاستفادة من أي من هذه العروض وحجز موعد؟ 📅\n\n` +
    `يمكنك التواصل معنا مباشرة عبر هذا الرقم لتأكيد الحجز.\n` +
    `نتطلع لخدمتك! 😊\n\n` +
    `_${CLINIC_NAME}_`
  );
}

/**
 * Build the final CTA message for the "All Offers" case.
 */
function buildAllOffersCTA() {
  return (
    `الرجاء اختيار العرض الذي ترغب في حجزه من الصور أعلاه 👆 وسنقوم بخدمتك فوراً! 😊\n\n` +
    `للحجز والاستفسار يمكنكم التواصل مع خدمة العملاء على الرقم: 920022480\n` +
    `أو عبر الواتساب: 0553144338\n\n` +
    `_${CLINIC_NAME}_`
  );
}

module.exports = { buildGreeting, buildImageCaption, buildServicesText, buildCTA, buildAllOffersCTA };
