import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from "socket.io";
import { ALLOWED_ORIGINS, MAX_SOCKET_CONNECTIONS, PORT } from './src/config/constants.js';
import { generalLimiter, sendImageLimiter } from './src/middleware/rateLimiter.js';
import * as whatsappController from './src/controllers/whatsapp.controller.js';
import whatsappService from './src/services/whatsapp.service.js';
import logger from './src/services/logger.service.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: ALLOWED_ORIGINS }
});

let activeSocketConnections = 0;

app.set('trust proxy', 1);
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10mb' }));

/********************* ENDPOINTS *********************/

app.get('/', (req, res) => { res.send('Servicio de WhatsApp funcionando'); });

// para ver el estado de la conexion y el QR
app.get('/api/whatsapp/status', whatsappController.getStatus);

// se solicita un nuevo QR
app.post('/api/whatsapp/request-qr', generalLimiter, whatsappController.requestQR);

// se reinicia la sesion de whatsapp
app.post('/api/whatsapp/reset', generalLimiter, whatsappController.resetSession);

// ruta dedicada para campañas desde Laravel
app.post('/api/whatsapp/send-campaign', sendImageLimiter, whatsappController.sendCampaign);

// ENVÍO GENÉRICO DE MENSAJES (para CRM)
app.post('/api/whatsapp/send-message', generalLimiter, whatsappController.sendMessage);

// CONFIGURAR WEBHOOK PARA MENSAJES ENTRANTES
app.post('/api/whatsapp/webhook', generalLimiter, whatsappController.setupWebhook);

// OBTENER MENSAJES RECIBIDOS
app.get('/api/whatsapp/received-messages', whatsappController.getReceivedMessages);

/********************* SOCKET.IO *********************/

// Socket.io para actualizaciones en tiempo real
io.on('connection', (socket) => {
	if (activeSocketConnections >= MAX_SOCKET_CONNECTIONS) {
		socket.emit('error', { message: 'Servidor con demasiadas conexiones, intenta más tarde' });
		socket.disconnect(true);
		return;
	}

	activeSocketConnections++;

	try {
		// Enviar estado actual inmediatamente
		const status = whatsappService.getStatus();
		socket.emit('qr-update', status);
	} catch (error) {
		logger.error('Error al enviar estado inicial al socket', {
			error: error.message,
			socketId: socket.id
		});
	}

	socket.on('disconnect', () => {
		logger.info('Cliente de socket desconectado', { socketId: socket.id });
		activeSocketConnections--;
	});

	socket.on('error', (error) => {
		logger.error('Error en socket', {
			error: error.message,
			socketId: socket.id
		});
	});

	// CRM puede suscribirse a mensajes entrantes
	socket.on('subscribe-messages', () => {
		logger.info('Cliente suscrito a mensajes entrantes', { socketId: socket.id });
	});
});

// se vincula Socket.IO al servicio de WhatsApp
whatsappService.setEventEmitter(io);

// error global del servidor
server.on('error', (error) => {
	logger.error('Error en el servidor HTTP', { error: error.message });
});

// Iniciar servidor
server.listen(PORT, () => {
	logger.info(`Servicio de WhatsApp iniciado en el puerto: ${PORT}`);
	whatsappService.initialize().catch(error => {
		logger.error('Error al inicializar WhatsApp', { error: error.message });
	});
});