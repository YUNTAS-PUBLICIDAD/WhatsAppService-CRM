import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import logger from './logger.service.js';
import { WHATSAPP_CONFIG } from '../config/constants.js';

class WhatsAppService {
    constructor() {
        this.sock = null;
        this.currentQR = null;
        this.isReady = false;
        this.isInitializing = false;
        this.initializePromise = null;
        this.qrTimeout = null;
        this.eventEmitter = null;
        this.webhookUrl = null;
        this.receivedMessages = [];
        this.maxStoredMessages = 100;
    }

    /**
     * Establece el emisor de eventos para Socket.IO
     */
    setEventEmitter(io) {
        this.eventEmitter = io;
    }

    /**
     * Emite evento de actualización de QR
     */
    emitQRUpdate(data) {
        if (this.eventEmitter) {
            this.eventEmitter.emit('qr-update', data);
        }
    }

    /**
     * Emite evento de mensaje entrante por Socket.IO
     */
    emitIncomingMessage(messageData) {
        if (this.eventEmitter) {
            this.eventEmitter.emit('incoming-message', messageData);
        }
    }

    /**
     * Envía mensaje entrante a webhook URL configurada
     */
    async sendToWebhook(messageData) {
        if (!this.webhookUrl) return;

        try {
            await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(messageData)
            });
        } catch (error) {
            logger.error('Error al enviar webhook', { error: error.message });
        }
    }

    /**
     * Almacena mensaje recibido en memoria
     */
    storeReceivedMessage(messageData) {
        this.receivedMessages.push(messageData);
        if (this.receivedMessages.length > this.maxStoredMessages) {
            this.receivedMessages.shift();
        }
    }

    /**
     * Configura URL del webhook para mensajes entrantes
     */
    setWebhookUrl(url) {
        this.webhookUrl = url;
        logger.info('Webhook URL configurada', { url });
    }

    /**
     * Obtiene mensajes recibidos recientes
     */
    getReceivedMessages(limit = 50) {
        return this.receivedMessages.slice(-limit);
    }

    /**
     * Inicializa el cliente de WhatsApp
     */
    async initialize() {
        if (this.sock) {
            logger.warn('Cliente de WhatsApp ya existe, cancelando inicialización');
            return this.sock;
        }

        if (this.isInitializing && this.initializePromise) {
            logger.warn('Inicialización de WhatsApp ya en curso, reutilizando promesa existente');
            return this.initializePromise;
        }

        this.isInitializing = true;
        this.initializePromise = (async () => {
            try {
                // se crea la carpeta de autenticacion si no existe
                if (!fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                    fs.mkdirSync(WHATSAPP_CONFIG.authPath, { recursive: true });
                }

                const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_CONFIG.authPath);

                const { version } = await fetchLatestBaileysVersion(); // version mas reciente

                this.sock = makeWASocket({ // socket de WhatsApp
                    version,
                    logger: pino({ level: 'silent' }),
                    printQRInTerminal: false,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                    },
                    browser: [WHATSAPP_CONFIG.sessionName, 'Chrome', '120.0.0'],
                    generateHighQualityLinkPreview: true,
                    syncFullHistory: false,
                    markOnlineOnConnect: false
                });

                // se manejan las actualizaciones de conexión
                this.sock.ev.on('connection.update', async (update) => {
                    await this.handleConnectionUpdate(update);
                });

                // se guarda las credenciales cuando cambien
                this.sock.ev.on('creds.update', saveCreds);

                // Escuchar mensajes entrantes
                this.sock.ev.on('messages.upsert', async (messageUpdate) => {
                    await this.handleIncomingMessages(messageUpdate);
                });

                return this.sock;
            } catch (error) {
                logger.error('Error al inicializar WhatsApp', { error: error.message });
                throw error;
            } finally {
                this.isInitializing = false;
                this.initializePromise = null;
            }
        })();

        return this.initializePromise;
    }

    /**
     * Maneja actualizaciones de conexión
     */
    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        // Manejar QR
        if (qr) {
            await this.handleQR(qr);
        }

        // Manejar cambios de conexión
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            logger.warn('Conexión cerrada (esto pasa a veces)', {
                reason: lastDisconnect?.error?.message,
                shouldReconnect
            });

            this.isReady = false;
            this.currentQR = null;

            this.emitQRUpdate({
                connectionStatus: 'disconnected',
                qrData: null
            });

            if (shouldReconnect) {
                logger.info('Reconectando...');
                this.sock = null;
                setTimeout(() => this.initialize(), 3000);
            } else {
                logger.info('Sesión cerrada por el usuario');
                this.sock = null;

                if (fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                    try {
                        const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                        for (const file of files) {
                            const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                            fs.rmSync(filePath, { recursive: true, force: true });
                        }
                    } catch (error) {
                        logger.warn('Error al eliminar contenido de auth_info, reintentando...', { error: error.message });
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                        for (const file of files) {
                            const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                            fs.rmSync(filePath, { recursive: true, force: true });
                        }
                    }
                }
            }
        } else if (connection === 'open') {
            logger.info('Cliente de WhatsApp listo');
            this.isReady = true;
            this.currentQR = null;
            clearTimeout(this.qrTimeout);

            this.emitQRUpdate({
                connectionStatus: 'connected',
                qrData: null
            });
        }
    }

    /**
     * Maneja la generación de QR
     */
    async handleQR(qr) {
        logger.info('Código QR generado - Escanea desde tu teléfono');

        try {
            this.currentQR = await QRCode.toDataURL(qr);

            console.log('\n========================================');
            console.log('  ESCANEA EL CÓDIGO QR CON TU TELÉFONO');
            console.log('========================================\n');
            qrcodeTerminal.generate(qr, { small: true }, (qrcode) => {
                console.log(qrcode);
            });
            console.log('========================================\n');

            clearTimeout(this.qrTimeout);
            this.qrTimeout = setTimeout(() => {
                if (!this.isReady) {
                    this.currentQR = null;
                }
            }, WHATSAPP_CONFIG.qrTimeout);

            this.emitQRUpdate({
                qrData: {
                    image: this.currentQR,
                    expiresAt: Date.now() + 60000,
                    createdAt: new Date().toISOString()
                },
                connectionStatus: 'qr-ready'
            });
        } catch (error) {
            logger.error('Error al generar código QR', { error: error.message });
        }
    }

    /**
     * Maneja mensajes entrantes de WhatsApp
     */
    async handleIncomingMessages(messageUpdate) {
        const { messages, type } = messageUpdate;

        // Solo procesar mensajes nuevos
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes propios
            if (msg.key.fromMe) continue;

            // Ignorar mensajes de grupos
            if (msg.key.remoteJid.includes('@g.us')) continue;

            try {
                const messageData = {
                    messageId: msg.key.id,
                    from: msg.key.remoteJid,
                    fromName: msg.pushName || 'Desconocido',
                    timestamp: msg.messageTimestamp,
                    text: this.extractMessageText(msg.message),
                    hasMedia: this.hasMedia(msg.message),
                    rawMessage: msg.message,
                    receivedAt: new Date().toISOString()
                };

                logger.info('Mensaje entrante recibido', {
                    from: messageData.from,
                    fromName: messageData.fromName,
                    text: messageData.text
                });

                // Almacenar en memoria
                this.storeReceivedMessage(messageData);

                // Emitir por Socket.IO
                this.emitIncomingMessage(messageData);

                // Enviar a webhook si está configurado
                await this.sendToWebhook(messageData);

            } catch (error) {
                logger.error('Error al procesar mensaje entrante', {
                    error: error.message,
                    messageId: msg.key.id
                });
            }
        }
    }

    /**
     * Extrae el texto del mensaje
     */
    extractMessageText(message) {
        if (!message) return '';

        if (message.conversation) return message.conversation;
        if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
        if (message.imageMessage?.caption) return message.imageMessage.caption;
        if (message.videoMessage?.caption) return message.videoMessage.caption;
        if (message.documentMessage?.caption) return message.documentMessage.caption;

        return '';
    }

    /**
     * Verifica si el mensaje tiene media
     */
    hasMedia(message) {
        if (!message) return false;

        return !!(
            message.imageMessage ||
            message.videoMessage ||
            message.audioMessage ||
            message.documentMessage ||
            message.stickerMessage
        );
    }

    /**
     * Valida si un número está registrado en WhatsApp
     */
    async validateNumber(numberId) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            const [result] = await this.sock.onWhatsApp(numberId);

            if (result && result.exists) {
                return result.jid;
            }

            return null;
        } catch (error) {
            logger.error('Error al validar número', { error: error.message, numberId });
            return null;
        }
    }

    /**
     * Envía un mensaje de texto
     */
    async sendMessage(jid, text) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            const result = await this.sock.sendMessage(jid, { text });

            logger.info('Mensaje de texto enviado', { jid });
            return {
                success: true,
                messageId: result.key.id,
                chatId: jid,
                timestamp: result.messageTimestamp
            };
        } catch (error) {
            logger.error('Error al enviar mensaje de texto', { error: error.message, jid });
            throw error;
        }
    }

    /**
     * Envía una imagen con caption (texto)
     */
    async sendImage(jid, imageBuffer, caption = '', mimetype = null) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            let message = {};
            const isGif = mimetype === 'image/gif';

            if (isGif) {
                // Para GIFs, usamos el formato de video con playback automático
                message = {
                    video: imageBuffer,
                    caption: caption || undefined,
                    gifPlayback: true
                };
            } else {
                // Para imágenes normales, volvemos a lo simple que funcionaba
                message = {
                    image: imageBuffer,
                    caption: caption || undefined
                };
            }

            const result = await this.sock.sendMessage(jid, message);
            logger.info('Mensaje enviado con éxito', { jid, isGif });
            return {
                success: true,
                messageId: result.key.id,
                chatId: jid,
                timestamp: result.messageTimestamp
            };
        } catch (error) {
            logger.error('Error al enviar imagen', { error: error.message, jid });
            throw error;
        }
    }

    /**
     * Reinicia la sesión de WhatsApp
     */
    async resetSession() {
        try {
            if (this.isInitializing) {
                throw new Error('Ya hay una operación en progreso');
            }

            this.isInitializing = true;

            await this.destroy(); // destruir recursos y cliente existente

            this.emitQRUpdate({
                connectionStatus: 'disconnected',
                qrData: null
            });

            // Esperar antes de eliminar archivos
            await new Promise(resolve => setTimeout(resolve, 1000));

            if (fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                try {
                    const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                    for (const file of files) {
                        const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                        fs.rmSync(filePath, { recursive: true, force: true });
                    }
                } catch (error) {
                    logger.warn('Error al eliminar contenido de auth_info, reintentando...', { error: error.message });
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                    for (const file of files) {
                        const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                        fs.rmSync(filePath, { recursive: true, force: true });
                    }
                }
            }

            this.isInitializing = false;

            logger.info('Sesión reseteada exitosamente');

            return true;
        } catch (error) {
            this.isInitializing = false;
            logger.error('Error al resetear sesión', { error: error.message });

            // Intentar inicializar
            try {
                await this.initialize();
            } catch (initError) {
                logger.error('Error al reinicializar después de fallo', { error: initError.message });
            }

            throw error;
        }
    }

    /**
     * Destruye el cliente y limpia recursos
     */
    async destroy() {
        if (this.sock) {
            this.sock.ev.removeAllListeners();
            await this.sock.logout();
            this.sock = null;
        }
        this.isReady = false;
        this.currentQR = null;
        this.initializePromise = null;
        clearTimeout(this.qrTimeout);
    }

    /**
     * Obtiene el estado actual
     */
    getStatus() {
        return {
            isConnected: this.isReady,
            hasActiveQR: !!this.currentQR,
            qrData: this.currentQR ? {
                image: this.currentQR,
                expiresAt: Date.now() + 60000
            } : null,
            connectionStatus: this.isReady ? 'connected' : (this.currentQR ? 'qr-ready' : 'disconnected')
        };
    }
}

export default new WhatsAppService();
