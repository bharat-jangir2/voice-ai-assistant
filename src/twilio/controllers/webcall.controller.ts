import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ConversationDbService } from '../services/conversation-db.service';

@Controller()
export class WebCallController {
  private readonly logger = new Logger(WebCallController.name);

  constructor(private readonly conversationDbService: ConversationDbService) {}

  // Start a web voice session (creates a 'webCall' conversation)
  @MessagePattern('voice:start')
  async startWebCall(
    @Payload()
    payload: {
      assistantId: string;
      organizationId: string;
      requestedUser?: any;
      headers?: any;
      metadata?: Record<string, any>;
    },
  ) {
    try {
      const { assistantId, organizationId, requestedUser, metadata } = payload || ({} as any);
      if (!assistantId || !organizationId || !requestedUser?._id) {
        return {
          success: false,
          statusCode: 400,
          userMessage: 'assistantId, organizationId and user are required',
          userMessageCode: 'VOICE_START_PARAMS_MISSING',
          developerMessage: 'assistantId, organizationId and requestedUser._id are required',
          data: { result: null },
        };
      }

      const conv = await this.conversationDbService.startConversation({
        organizationId,
        assistantId,
        userId: requestedUser._id,
        type: 'webCall',
        direction: 'inbound',
        stream: true,
        metadata: metadata || {},
      });

      // Socket.IO server URL (running on port 3002 with /voice namespace)
      // Use environment variable or default to localhost:3002/voice
      const socketPort = process.env.SOCKET_IO_PORT || '3002';
      const socketHost = process.env.SOCKET_IO_HOST || 'localhost';
      const protocol = process.env.SOCKET_IO_PROTOCOL || 'http';
      const wsUrl = process.env.WEB_VOICE_WS_URL || `${protocol}://${socketHost}:${socketPort}/voice`;

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Web voice session started successfully',
        userMessageCode: 'VOICE_START_SUCCESS',
        developerMessage: 'Conversation created for webCall',
        data: {
          result: {
            sessionId: conv._id,
            wsUrl,
            stt: { codec: 'opus' },
            tts: { codec: 'opus' },
          },
        },
      };
    } catch (error) {
      this.logger.error('Failed to start web voice session', error);
      return {
        success: false,
        statusCode: 400,
        userMessage: 'Failed to start web voice session',
        userMessageCode: 'VOICE_START_FAILED',
        developerMessage: error?.message || 'VOICE_START_FAILED',
        data: { result: null },
      };
    }
  }

  // End a web voice session (ends conversation)
  @MessagePattern('voice:end')
  async endWebCall(@Payload() payload: { sessionId: string }) {
    try {
      const { sessionId } = payload || ({} as any);
      if (!sessionId) {
        return {
          success: false,
          statusCode: 400,
          userMessage: 'sessionId is required',
          userMessageCode: 'SESSION_ID_REQUIRED',
          developerMessage: 'sessionId is required',
          data: { result: null },
        };
      }

      const ended = await this.conversationDbService.endConversation({ conversationId: sessionId, endedReason: 'user-ended' });

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Web voice session ended successfully',
        userMessageCode: 'VOICE_END_SUCCESS',
        developerMessage: 'Conversation ended',
        data: {
          result: {
            conversationId: ended._id,
            status: ended.status,
            endedAt: ended.endedAt,
            duration: ended.duration,
          },
        },
      };
    } catch (error) {
      this.logger.error('Failed to end web voice session', error);
      return {
        success: false,
        statusCode: 400,
        userMessage: 'Failed to end web voice session',
        userMessageCode: 'VOICE_END_FAILED',
        developerMessage: error?.message || 'VOICE_END_FAILED',
        data: { result: null },
      };
    }
  }
}
