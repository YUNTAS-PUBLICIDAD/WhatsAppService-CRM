import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_CONFIG } from '../config/constants.js';

export const generalLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.general.windowMs,
    max: RATE_LIMIT_CONFIG.general.max,
    message: RATE_LIMIT_CONFIG.general.message,
    standardHeaders: true,
    legacyHeaders: false
});

export const sendMessageLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.sendMessage.windowMs,
    max: RATE_LIMIT_CONFIG.sendMessage.max,
    message: { success: false, message: 'Límite de mensajes alcanzado, espera un momento' },
    standardHeaders: true,
    legacyHeaders: false
});

export const sendImageLimiter = rateLimit({
    windowMs: RATE_LIMIT_CONFIG.sendImage.windowMs,
    max: RATE_LIMIT_CONFIG.sendImage.max,
    message: { success: false, message: 'Límite de imágenes alcanzado, espera un momento' },
    standardHeaders: true,
    legacyHeaders: false
});
