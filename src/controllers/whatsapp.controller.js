import whatsappService from '../services/whatsapp.service.js';
import logger from '../services/logger.service.js';
import { getProductDetailsTemplate } from '../../templates.js';
import { WHATSAPP_CONFIG } from '../config/constants.js';

// NO importar mysql aquí arriba
let pool = null;

// Función para obtener la conexión solo cuando se necesite

/**
 * Obtiene el estado de la conexión de WhatsApp y el QR
 */
export async function getStatus(req, res) {
    try {
        const status = whatsappService.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('Error al obtener estado de WhatsApp', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al obtener el estado'
        });
    }
}

/**
 * Solicita un nuevo código QR
 */
export async function requestQR(req, res) {
    try {
        if (whatsappService.isReady) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp ya está conectado'
            });
        }

        if (whatsappService.isInitializing) {
            return res.status(409).json({
                success: false,
                message: 'Ya hay una operación en progreso'
            });
        }

        // Si no existe el socket, se inicializa
        if (!whatsappService.sock) {
            await whatsappService.initialize();
        } else {
            // Si existe, se destruye y reinicia
            await whatsappService.destroy();
            await whatsappService.initialize();
        }

        res.json({
            success: true,
            message: 'Generando nuevo QR...'
        });
    } catch (error) {
        logger.error('Error al solicitar nuevo QR', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al generar QR'
        });
    }
}

/**
 * Reinicia la sesión de WhatsApp
 */
export async function resetSession(req, res) {
    try {
        if (whatsappService.isInitializing) {
            return res.status(409).json({
                success: false,
                message: 'Ya hay una operación de reseteo en progreso'
            });
        }

        await whatsappService.resetSession();

        res.json({
            success: true,
            message: 'Sesión reseteada'
        });
    } catch (error) {
        logger.error('Error al resetear la sesión de WhatsApp', { error: error.message });
        if (whatsappService.sock) {
            res.json({
                success: true,
                message: 'Sesión reiniciada con advertencias. Generando QR...',
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Error al reiniciar sesión',
            });
        }
    }
}

/**
 * Procesa una imagen (URL o Base64) y devuelve un Buffer y el Mimetype detectado
 */
async function processImage(imageSource) {
    if (!imageSource) return { buffer: null, mimetype: null };

    let imageBuffer;
    let detectedMimetype = null;

    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
        try {
            const response = await fetch(imageSource);
            if (!response.ok) throw new Error('No se pudo descargar la imagen');
            detectedMimetype = response.headers.get('content-type') || null;
            imageBuffer = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            logger.error('Error al descargar imagen', { error: error.message, url: imageSource });
            return { buffer: null, mimetype: null };
        }
    } else if (imageSource.startsWith('data:')) {
        // Método robusto para data URIs
        const parts = imageSource.split(',');
        if (parts.length === 2) {
            const mimeMatch = parts[0].match(/data:([^;]+);/);
            detectedMimetype = mimeMatch ? mimeMatch[1] : null;
            imageBuffer = Buffer.from(parts[1], 'base64');
        }
    } else {
        // Si viene base64 puro
        imageBuffer = Buffer.from(imageSource, 'base64');
    }

    return { buffer: imageBuffer, mimetype: detectedMimetype };
}

/**
 * Envía campaña de WhatsApp (llamado desde Laravel)
 */
export async function sendCampaign(req, res) {
    try {
        if (!whatsappService.isReady) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp no está conectado'
            });
        }

        const { phone, message, image, messages } = req.body;

        // Limpiar número
        const numberId = (phone || (messages && messages[0] && messages[0].phone) || '').replace(/\D/g, '');
        if (numberId.length < 10 || numberId.length > 15) {
            return res.status(400).json({ success: false, message: 'Número de teléfono no válido' });
        }
        const jid = await whatsappService.validateNumber(`${numberId}@s.whatsapp.net`);
        if (!jid) return res.status(404).json({ success: false, message: 'Número no registrado' });

        // Función interna para enviar un mensaje individual
        const sendOne = async (msgText, msgImage) => {
            try {
                if (msgImage) {
                    const { buffer, mimetype } = await processImage(msgImage);
                    return await whatsappService.sendImage(jid, buffer, msgText, mimetype);
                }
                return await whatsappService.sendMessage(jid, msgText);
            } catch (err) {
                logger.error('Error enviando mensaje individual en campaña', { error: err.message });
                throw err;
            }
        };

        // Si viene un array de mensajes (Secuencia)
        if (Array.isArray(messages) && messages.length > 0) {
            // Enviamos respuesta inmediata para que Laravel no espere
            res.json({ success: true, message: 'Secuencia de mensajes iniciada' });

            let currentDelay = 0;
            for (const msg of messages) {
                currentDelay += (msg.delay || 0);
                setTimeout(async () => {
                    try {
                        await sendOne(msg.message, msg.image);
                        logger.info('Mensaje de secuencia enviado', { phone: numberId, delay: msg.delay });
                    } catch (e) {
                        logger.error('Fallo en mensaje de secuencia', { error: e.message });
                    }
                }, currentDelay * 60000); // convertir minutos a ms
            }
            return;
        }

        // Si es un mensaje único (Tradicional)
        if (!message) return res.status(400).json({ success: false, message: 'Mensaje obligatorio' });
        
        const result = await sendOne(message, image);
        logger.info('Campaña única enviada correctamente', { phone: numberId });
        res.json(result);

    } catch (error) {
        logger.error('Error al enviar campaña de WhatsApp', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al enviar la campaña: ' + error.message
        });
    }
}

/**
 * Envía mensaje genérico de texto (para CRM)
 */
export async function sendMessage(req, res) {
    try {
        if (!whatsappService.isReady) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp no está conectado'
            });
        }

        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                message: 'El teléfono y el mensaje son obligatorios'
            });
        }

        // Detectar si es un LID (Linked Identity) o un número telefónico
        const isLid = phone.includes('@lid');
        let jid;

        if (isLid) {
            // Es un LID: usar el nuevo método que maneja LIDs
            jid = await whatsappService.getJidForSending(phone);
        } else {
            // Es un número telefónico: limpiar y validar
            const numberId = phone.replace(/\D/g, '');
            if (numberId.length < 10 || numberId.length > 15) {
                return res.status(400).json({
                    success: false,
                    message: 'El formato del número de teléfono no es válido'
                });
            }
            jid = await whatsappService.getJidForSending(numberId);
        }

        if (!jid) {
            return res.status(404).json({
                success: false,
                message: 'El número no está registrado en WhatsApp'
            });
        }

        const result = await whatsappService.sendMessage(jid, message);

        res.json(result);
    } catch (error) {
        logger.error('Error al enviar mensaje', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al enviar el mensaje'
        });
    }
}

/**
 * Configura URL del webhook para mensajes entrantes
 */
export async function setupWebhook(req, res) {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'La URL del webhook es obligatoria'
            });
        }

        // Validar URL
        try {
            new URL(url);
        } catch {
            return res.status(400).json({
                success: false,
                message: 'La URL del webhook no es válida'
            });
        }

        whatsappService.setWebhookUrl(url);

        res.json({
            success: true,
            message: 'Webhook configurado correctamente',
            url: url
        });
    } catch (error) {
        logger.error('Error al configurar webhook', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al configurar el webhook'
        });
    }
}

/**
 * Obtiene mensajes recibidos recientes
 */
export async function getReceivedMessages(req, res) {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const messages = whatsappService.getReceivedMessages(limit);

        res.json({
            success: true,
            messages: messages,
            total: messages.length
        });
    } catch (error) {
        logger.error('Error al obtener mensajes recibidos', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al obtener los mensajes'
        });
    }
}

