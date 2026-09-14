export const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
];

export const MAX_SOCKET_CONNECTIONS = 10;
export const PORT = process.env.PORT || 3001;

// Configuracion de rate limiting
export const RATE_LIMIT_CONFIG = {
    general: {
        windowMs: 1 * 60 * 1000, // 1 minuto
        max: 60, // 60 peticiones por minuto
        message: { success: false, message: 'Demasiadas peticiones, intenta más tarde' }
    },
    sendMessage: {
        windowMs: 1 * 60 * 1000,
        max: 20
    },
    sendImage: {
        windowMs: 1 * 60 * 1000,
        max: 60
    }
};

// Configuracion de WhatsApp
export const WHATSAPP_CONFIG = {
    authPath: './auth_info',
    sessionName: 'Tami Maquinarias',
    qrTimeout: 120000, // 2 minutos
    maxImageSize: 2 // MB
};
