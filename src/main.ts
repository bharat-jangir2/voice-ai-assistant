import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger, ValidationPipe } from '@nestjs/common';
import * as http from 'http';
import { Server } from 'socket.io';
import { ChatGateway } from './twilio/gateway/chat.gateway';
import { WebVoiceGateway } from './twilio/gateway/web-voice.gateway';

async function bootstrap() {
  // Create a logger instance for the main application
  const logger = new Logger('Main');

  // Set the port from environment variable or default to 9002
  const port = parseInt(process.env.PORT || '9002');

  // Set the host from environment variable or default to '0.0.0.0'
  const host = process.env.HOST || '0.0.0.0';

  // Create a microservice application with TCP transport
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.TCP,
    options: { host, port },
  });

  // Add global validation pipe to enable class-validator decorators
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      validateCustomDecorators: true,
    }),
  );

  // Start listening for incoming connections
  await app.listen();

  // Create separate HTTP server for Socket.IO on port 3002
  const socketServer = http.createServer();
  const io = new Server(socketServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Get ChatGateway from NestJS container and initialize handlers
  const chatGateway = app.get(ChatGateway);
  chatGateway.initialize(io);
  const webVoiceGateway = app.get(WebVoiceGateway);
  webVoiceGateway.initialize(io);

  // Start Socket.IO server on port 3002
  const socketPort = 3002;
  socketServer.listen(socketPort, '0.0.0.0', () => {
    console.log(`🚀 Socket.IO server is running on port ${socketPort}`);
  });

  // Log the service details
  logger.log(`Assistant service is listening on PORT: ${port} | HOST : ${host} | ENVIRONMENT: ${process.env.ENVIRONMENT}`);
}
bootstrap();
