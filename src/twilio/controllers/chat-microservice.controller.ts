import { Controller, Logger, Inject, Get, Query } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { DirectAIService } from '../services/direct-ai.service';
import { ConversationDbService } from '../services/conversation-db.service';
import { KnowledgeBaseSearchService } from '../services/knowledge-base-search.service';
import { KnowledgeBaseResponseService, FineTunedResponse } from '../services/knowledge-base-response.service';
import { CostCalculationService } from '../services/cost-calculation.service';
import { firstValueFrom } from 'rxjs';

// ============================================
// DTOs for Chat Microservice Messages
// ============================================

export interface ChatPayload {
  headers: any;
  requestedUser: any;
  chatMessageDto: {
    assistantId: string;
    message?: string;
    userId: string;
    organizationId: string;
    stream?: boolean;
    metadata?: Record<string, any>;
  };
}

export interface ChatResponse {
  success: boolean;
  sessionId: string | null;
  userMessage: string;
  userMessageCode: string;
  developerMessage: string;
  data: {
    result: {
      message?: string;
      messages?: any[];
      timestamp: string;
    };
  };
}

// ============================================
// Chat Microservice Controller in Assistant Service
// ============================================
@Controller('chat')
export class ChatMicroserviceController {
  private readonly logger = new Logger(ChatMicroserviceController.name);

  constructor(
    private readonly directAIService: DirectAIService,
    private readonly conversationDbService: ConversationDbService,
    private readonly knowledgeBaseSearchService: KnowledgeBaseSearchService,
    private readonly knowledgeBaseResponseService: KnowledgeBaseResponseService,
    private readonly costCalculationService: CostCalculationService,
    @Inject('userService') private readonly userServiceClient: any,
  ) {}

  // Note: HTTP route for logs removed to enforce microservice-only access

  // Microservice: Returns chat conversations(chat logs) with message counts (paginated)
  @MessagePattern('chat:get-logs')
  async msGetChatLogs(
    @Payload()
    payload: {
      headers?: any;
      requestedUser?: any;
      query?: { organizationId?: string; page?: number | string; limit?: number | string; chatId?: string; assistantId?: string };
    },
  ) {
    try {
      const orgFromJwt = payload?.requestedUser?.organizationId;
      const q = payload?.query || {};
      const orgId = q.organizationId || orgFromJwt;
      const pageNum = Math.max(parseInt((q.page as any) || '1', 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt((q.limit as any) || '20', 10) || 20, 1), 100);
      const offsetNum = (pageNum - 1) * limitNum;
      const chatId = q.chatId as string | undefined;
      const assistantId = q.assistantId as string | undefined;

      if (!orgId) {
        return this.errorResponse('organizationId is required', 'ORGANIZATION_ID_REQUIRED');
      }

      // If a specific chat is requested
      if (chatId) {
        const conv = await this.conversationDbService.getConversation(chatId);
        const single = conv
          ? [
              {
                _id: conv._id,
                organizationId: conv.organizationId,
                assistantId: conv.assistantId,
                userId: conv.userId,
                type: conv.type,
                direction: conv.direction,
                status: conv.status,
                stream: conv.stream,
                startedAt: conv.startedAt,
                lastActivityAt: conv.lastActivityAt,
                messageCount: conv?.conversationMetrics?.totalMessages ?? 0,
              },
            ]
          : [];

        return {
          success: true,
          statusCode: 200,
          userMessage: 'Chat logs fetched successfully',
          userMessageCode: 'CHAT_LOGS_FETCHED_SUCCESS',
          developerMessage: 'Conversations list with message counts',
          data: {
            result: single,
            pagination: {
              page: 1,
              limit: single.length || limitNum,
              total: single.length,
              hasNext: false,
              hasPrev: false,
            },
          },
        };
      }

      const { conversations, total } = await this.conversationDbService.getConversations(orgId, pageNum, limitNum);

      let items = (conversations || []).map((c: any) => ({
        _id: c._id,
        organizationId: c.organizationId,
        assistantId: c.assistantId,
        userId: c.userId,
        type: c.type,
        direction: c.direction,
        status: c.status,
        stream: c.stream,
        startedAt: c.startedAt,
        lastActivityAt: c.lastActivityAt,
        messageCount: c?.conversationMetrics?.totalMessages ?? 0,
      }));

      if (assistantId) {
        items = items.filter((c: any) => c.assistantId?.toString() === assistantId);
      }

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Chat logs fetched successfully',
        userMessageCode: 'CHAT_LOGS_FETCHED_SUCCESS',
        developerMessage: 'Conversations list with message counts',
        data: {
          result: items,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            hasNext: offsetNum + items.length < total,
            hasPrev: pageNum > 1,
          },
        },
      };
    } catch (error) {
      this.logger.error('Failed to get chat logs', error);
      return this.errorResponse('Failed to get chat logs', 'CHAT_LOGS_FETCH_FAILED');
    }
  }

  // Microservice: Returns paginated messages for a conversation (same response shape)
  @MessagePattern('chat:get-messages')
  async msGetConversationMessages(
    @Payload()
    payload: {
      headers?: any;
      requestedUser?: any;
      query?: { chatId: string; page?: number | string; limit?: number | string; role?: string };
    },
  ) {
    try {
      const q = payload?.query || ({} as any);
      const conversationId = q.chatId as string;
      const pageNum = Math.max(parseInt((q.page as any) || '1', 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt((q.limit as any) || '20', 10) || 20, 1), 100);
      const roleFilter = (q.role || '').toString().toLowerCase();

      if (!conversationId) {
        return this.errorResponse('chatId is required', 'CHAT_ID_REQUIRED');
      }

      // Get total from conversation metrics
      const conversation = await this.conversationDbService.getConversation(conversationId);
      const metrics = conversation?.conversationMetrics || {};
      const totalFromMetrics =
        roleFilter === 'user'
          ? metrics.userMessages
          : roleFilter === 'assistant'
            ? metrics.assistantMessages
            : metrics.totalMessages;

      // Fetch paginated messages
      const messages = await this.conversationDbService.getConversationMessages(conversationId, pageNum, limitNum);

      let items = (messages || []).map((m: any) => ({
        _id: m._id,
        conversationId: m.conversationId,
        organizationId: m.organizationId,
        assistantId: m.assistantId,
        userId: m.userId,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || m.createdAt,
        source: m.source,
        metadata: m.metadata,
      }));

      if (roleFilter) {
        items = items.filter((m: any) => (m.role || '').toLowerCase() === roleFilter);
      }

      const total = typeof totalFromMetrics === 'number' ? totalFromMetrics : items.length;

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Conversation messages fetched successfully',
        userMessageCode: 'CONVERSATION_MESSAGES_FETCHED_SUCCESS',
        developerMessage: 'Paginated conversation messages',
        data: {
          result: items,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            hasNext: pageNum * limitNum < total,
            hasPrev: pageNum > 1,
          },
        },
      };
    } catch (error) {
      this.logger.error('Failed to get conversation messages', error);
      return this.errorResponse('Failed to get conversation messages', 'CONVERSATION_MESSAGES_FETCH_FAILED');
    }
  }

  // Microservice: Soft delete a conversation and optionally its messages
  @MessagePattern('chat:delete-conversation')
  async msDeleteConversation(
    @Payload() payload: { conversationId: string; deleteMessages?: boolean; headers?: any; requestedUser?: any },
  ) {
    try {
      const { conversationId, deleteMessages = true } = payload || ({} as any);
      if (!conversationId) {
        return this.errorResponse('conversationId is required', 'CONVERSATION_ID_REQUIRED');
      }

      const response: any = await firstValueFrom(
        this.userServiceClient.send('conversation:soft-delete', { conversationId, deleteMessages }),
      );

      if (!response?.success) {
        const notFound =
          response?.statusCode === 404 || response?.error === 'NotFoundException' || /not found/i.test(response?.message || '');
        return {
          success: false,
          statusCode: notFound ? 404 : 400,
          userMessage: response?.message || 'Failed to delete conversation',
          userMessageCode: notFound ? 'CONVERSATION_NOT_FOUND' : 'CONVERSATION_DELETE_FAILED',
          developerMessage: response?.message || 'Failed to delete conversation',
          data: { result: { conversationId } },
        };
      }

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Conversation deleted successfully',
        userMessageCode: 'CONVERSATION_DELETE_SUCCESS',
        developerMessage: 'Conversation soft-deleted',
        data: {
          result: response.data,
        },
      };
    } catch (error) {
      this.logger.error('Failed to delete conversation', error);
      return this.errorResponse('Failed to delete conversation', 'CONVERSATION_DELETE_FAILED');
    }
  }

  // Microservice: Soft delete a single message
  @MessagePattern('chat:delete-message')
  async msDeleteMessage(@Payload() payload: { messageId: string }) {
    try {
      const { messageId } = payload || ({} as any);
      if (!messageId) {
        return this.errorResponse('messageId is required', 'MESSAGE_ID_REQUIRED');
      }

      const response: any = await firstValueFrom(this.userServiceClient.send('conversation:soft-delete-message', { messageId }));

      if (!response?.success) {
        const notFound =
          response?.statusCode === 404 || response?.error === 'NotFoundException' || /not found/i.test(response?.message || '');
        return {
          success: false,
          statusCode: notFound ? 404 : 400,
          userMessage: response?.message || 'Failed to delete message',
          userMessageCode: notFound ? 'MESSAGE_NOT_FOUND' : 'MESSAGE_DELETE_FAILED',
          developerMessage: response?.message || 'Failed to delete message',
          data: { result: { messageId } },
        };
      }

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Message deleted successfully',
        userMessageCode: 'MESSAGE_DELETE_SUCCESS',
        developerMessage: 'Message soft-deleted',
        data: {
          result: response.data,
        },
      };
    } catch (error) {
      this.logger.error('Failed to delete message', error);
      return this.errorResponse('Failed to delete message', 'MESSAGE_DELETE_FAILED');
    }
  }

  // Microservice: End a chat session by conversationId
  @MessagePattern('chat:end-session')
  async msEndSession(@Payload() payload: { sessionId: string; reason?: string; headers?: any; requestedUser?: any }) {
    try {
      const { sessionId, reason } = payload || ({} as any);
      if (!sessionId) {
        return this.errorResponse('sessionId is required', 'SESSION_ID_REQUIRED');
      }

      const ended = await this.conversationDbService.endConversation({
        conversationId: sessionId,
        endedReason: reason || 'user-ended',
      });

      return {
        success: true,
        statusCode: 200,
        userMessage: 'Session ended successfully',
        userMessageCode: 'SESSION_ENDED_SUCCESS',
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
      this.logger.error('Failed to end session', error);
      return this.errorResponse('Failed to end session', 'SESSION_END_FAILED');
    }
  }

  /**
   * Handle message request - combines session creation and messaging
   */
  @MessagePattern('chat:message')
  async processMessage(@Payload() payload: ChatPayload): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      const { chatMessageDto } = payload;
      const { assistantId, message, userId, organizationId, stream } = chatMessageDto;

      // 1. Early validation
      if (message && !this.validateMessage(message)) {
        return this.errorResponse('Invalid message format', 'INVALID_MESSAGE');
      }

      // 2. Get or create session (with caching)
      const session = await this.getOrCreateSession({
        userId,
        assistantId,
        organizationId,
      });

      // 3. If no message, return history only
      if (!message) {
        return this.getConversationHistory(session.id);
      }

      // 4. Get assistant config first to determine AI provider
      const assistantConfig = await this.getAssistantConfiguration(assistantId, organizationId, userId);
      this.logger.log(`🔍 Assistant: ${assistantConfig.name}`);
      this.logger.log(`🔍 Provider: ${assistantConfig.modelConfig?.provider || 'not set'}`);
      this.logger.log(`🔍 Model: ${assistantConfig.modelConfig?.model || 'not set'}`);

      // 5. Get credentials based on assistant's AI provider configuration
      let credentials = await this.getCredentialsForAssistant(assistantConfig, userId, organizationId);

      // If no user credentials found, try system credentials from environment
      if (!this.hasValidCredentials(credentials)) {
        this.logger.warn(`⚠️ [CREDENTIALS] No user credentials found, trying system credentials`);
        credentials = this.getSystemCredentials();

        if (!this.hasValidCredentials(credentials)) {
          return this.errorResponse('AI credentials not configured for this assistant', 'CREDENTIALS_MISSING');
        }

        this.logger.log(`✅ [CREDENTIALS] Using system credentials from environment`);
      }

      // 5.5. Check knowledge base and search for relevant content
      let knowledgeBaseResponse: FineTunedResponse | null = null;
      // Knowledge base config is nested under modelConfig
      const kbConfig = assistantConfig.modelConfig?.knowledgeBase || assistantConfig.knowledgeBase;
      this.logger.log(`🔍 Assistant KB config: ${JSON.stringify(kbConfig)}`);

      if (kbConfig?.fileIds?.length > 0) {
        this.logger.log(`📚 Searching knowledge base with ${kbConfig.fileIds.length} files: [${kbConfig.fileIds.join(', ')}]`);

        try {
          const kbResults = await this.knowledgeBaseSearchService.searchKnowledgeBase(message, kbConfig.fileIds, organizationId, {
            similarityThreshold: 0.25, // 25% similarity threshold (very low for better matching)
            maxResultsPerFile: 5, // Max 5 results per file
            maxTotalResults: 15, // Max 15 total results
            cacheTtlSeconds: 300, // 5 minutes cache
          });

          if (kbResults.length > 0) {
            this.logger.log(`📚 Found ${kbResults.length} relevant KB results`);

            // Check if we should use KB results
            if (this.knowledgeBaseResponseService.shouldUseKnowledgeBase(kbResults)) {
              // Try to get fallback AI response for comparison (optional, don't fail if it errors)
              let fallbackResponse: string | undefined;
              let fallbackAICost: any = null;
              let fallbackAITokens: any = null;

              try {
                const fallbackAIResponse = await this.getFallbackAIResponse(message, assistantConfig, credentials);
                fallbackResponse = fallbackAIResponse.content;
                fallbackAICost = fallbackAIResponse.cost;
                fallbackAITokens = fallbackAIResponse.tokens;
              } catch (error) {
                this.logger.debug(`Fallback AI response unavailable, using KB response only: ${error.message}`);
              }

              // Create fine-tuned response
              knowledgeBaseResponse = this.knowledgeBaseResponseService.createFineTunedResponse(
                message,
                kbResults,
                fallbackResponse,
              );

              // Store fallback AI cost in KB response metadata
              (knowledgeBaseResponse as any).fallbackAICost = fallbackAICost;
              (knowledgeBaseResponse as any).fallbackAITokens = fallbackAITokens;
              (knowledgeBaseResponse as any).searchOperations = kbConfig.fileIds.length; // Number of files searched

              this.logger.log(`📚 Using KB response with confidence: ${knowledgeBaseResponse.confidence}`);
            } else {
              this.logger.log(`📚 KB results found but confidence too low, using normal AI flow`);
            }
          } else {
            this.logger.log(`📚 No relevant KB results found, using normal AI flow`);
          }
        } catch (error) {
          this.logger.warn(`📚 Knowledge base search failed: ${error.message}, using normal AI flow`);
        }
      } else {
        this.logger.log(`📚 No knowledge base files configured for this assistant`);
      }

      // 6. Store user message
      await this.storeMessage(session.id, 'user', message);

      // 7. Build context with token management
      const context = await this.buildContext(session.id, assistantConfig.modelConfig?.maxTokens || 4000);

      // 8. Get AI response (with streaming support) or use KB response
      if (knowledgeBaseResponse && knowledgeBaseResponse.isFromKnowledgeBase) {
        // Use knowledge base response
        this.logger.log(`📚 Returning KB response with confidence: ${knowledgeBaseResponse.confidence}`);

        // Calculate KB operation costs
        const kbResponseMetadata = knowledgeBaseResponse as any;
        const kbCostBreakdown = this.costCalculationService.createKnowledgeBaseCostBreakdown({
          queryEmbeddingCost: undefined, // Will use default from KB_EMBEDDING_COST_USD env var
          searchOperations: kbResponseMetadata.searchOperations || 1,
          fallbackAICost: kbResponseMetadata.fallbackAICost?.amount,
          fallbackAITokens: kbResponseMetadata.fallbackAITokens
            ? {
                promptTokens: kbResponseMetadata.fallbackAITokens.prompt || 0,
                completionTokens: kbResponseMetadata.fallbackAITokens.completion || 0,
                totalTokens: kbResponseMetadata.fallbackAITokens.total || 0,
              }
            : undefined,
        });

        this.logger.log(
          `💰 KB Cost breakdown: Embedding: $${kbCostBreakdown.breakdown.embeddingCost.toFixed(6)}, Search: $${kbCostBreakdown.breakdown.searchCost.toFixed(6)}, AI: $${kbCostBreakdown.breakdown.aiCost.toFixed(6)}, Total: $${kbCostBreakdown.amount.toFixed(6)}`,
        );

        // Store KB response with cost breakdown
        await this.storeMessage(session.id, 'assistant', knowledgeBaseResponse.content, {
          cost: kbCostBreakdown,
          tokens: kbResponseMetadata.fallbackAITokens || {
            prompt: 0,
            completion: 0,
            total: 0,
          },
          model: 'knowledge-base',
          processingTime: Date.now() - startTime,
          sources: knowledgeBaseResponse.sources,
          confidence: knowledgeBaseResponse.confidence,
          kbBreakdown: kbCostBreakdown.breakdown,
        });

        return this.successResponse(session.id, knowledgeBaseResponse.content);
      } else {
        // Use normal AI flow
        if (stream) {
          return this.streamAIResponse(message, context, assistantConfig, credentials, session.id);
        } else {
          const aiResponse = await this.getAIResponse(message, context, assistantConfig, credentials);

          // 9. Store assistant response with actual metrics
          await this.storeMessage(session.id, 'assistant', aiResponse.content, {
            cost: aiResponse.cost, // Real cost from provider
            tokens: aiResponse.tokens, // Real token usage
            model: aiResponse.model,
            processingTime: Date.now() - startTime,
          });

          return this.successResponse(session.id, aiResponse.content);
        }
      }
    } catch (error) {
      this.logger.error('Message processing failed', error);
      return this.errorResponse(error.message, 'PROCESSING_FAILED');
    }
  }

  // Streaming variant: emits VAPI-style delta events as Observable
  @MessagePattern('chat:message-stream')
  streamMessage(@Payload() payload: ChatPayload): Observable<any> {
    const startTime = Date.now();
    const self = this;
    return new Observable<any>((observer) => {
      (async () => {
        try {
          const { chatMessageDto } = payload;
          const { assistantId, message, userId, organizationId } = chatMessageDto;

          // 1) Get or create session
          const session = await self.getOrCreateSession({ userId, assistantId, organizationId });

          // 2) Emit session id meta (optional) in generic structure path
          observer.next({ id: session.id, path: 'data.result.sessionId', delta: session.id, done: false });

          // 3) Get assistant config and credentials
          const assistantConfig = await self.getAssistantConfiguration(assistantId, organizationId, userId);
          let credentials = await self.getCredentialsForAssistant(assistantConfig, userId, organizationId);
          if (!self.hasValidCredentials(credentials)) {
            credentials = self.getSystemCredentials();
          }

          // 4) Store user message
          if (message) {
            await self.storeMessage(session.id, 'user', message);
          }

          // 5) Build context and get full AI response (simulate token streaming)
          const context = await self.buildContext(session.id, assistantConfig.modelConfig?.maxTokens || 4000);
          const ai = await self.getAIResponse(message || '', context, assistantConfig, credentials);

          // 6) Stream chunks
          const contentPath = 'data.result.content';
          const text = ai.content || '';
          const chunks = (text || '').match(/\S+|\s+|[\.!?]/g) || [text];
          for (const chunk of chunks) {
            observer.next({ id: session.id, path: contentPath, delta: chunk, done: false });
          }
          // finalize
          observer.next({ id: session.id, path: contentPath, delta: '', done: true });

          // 7) Persist assistant message with metrics
          await self.storeMessage(session.id, 'assistant', ai.content, {
            cost: ai.cost,
            tokens: ai.tokens,
            model: ai.model,
            processingTime: Date.now() - startTime,
          });

          observer.complete();
        } catch (err) {
          observer.error({ error: true, message: err?.message || 'STREAM_FAILED' });
        }
      })();
    });
  }

  // Helper methods for the refactored processMessage
  private validateMessage(message: string): boolean {
    if (!message || message.trim().length === 0) return false;
    if (message.length > 10000) return false; // Max message length
    return true;
  }

  private async getOrCreateSession(params: {
    userId: string;
    assistantId: string;
    organizationId: string;
  }): Promise<{ id: string }> {
    const { userId, assistantId, organizationId } = params;
    const sessionKey = `${userId}_${assistantId}_${organizationId}`;

    let conversation = await this.findExistingSession(sessionKey);

    // Check if existing session is expired (older than 24 hours)
    if (conversation) {
      // Use startedAt if available, otherwise fall back to createdAt
      const sessionStartTime = conversation.startedAt
        ? new Date(conversation.startedAt).getTime()
        : new Date(conversation.createdAt).getTime();

      const sessionAge = Date.now() - sessionStartTime;
      const twentyFourHours = 24 * 60 * 60 * 1000;

      this.logger.log(`🔍 [SESSION] Session age check: ${Math.round(sessionAge / (60 * 60 * 1000))} hours old (max: 24 hours)`);

      if (sessionAge > twentyFourHours) {
        this.logger.log(
          `🔄 [SESSION] Session expired (${Math.round(sessionAge / (60 * 60 * 1000))} hours old), creating new one for ${sessionKey}`,
        );
        conversation = null; // Force creation of new session
      } else {
        this.logger.log(
          `✅ [SESSION] Using existing active session: ${conversation._id} (${Math.round(sessionAge / (60 * 60 * 1000))} hours old)`,
        );
      }
    }

    if (!conversation) {
      this.logger.log(`🆕 [SESSION] Creating new conversation for ${sessionKey}`);
      conversation = await this.conversationDbService.startConversation({
        organizationId,
        assistantId,
        userId,
        type: 'chat',
        direction: 'inbound',
        stream: false,
        metadata: {},
      });

      // Send first assistant greeting message
      await this.conversationDbService.sendMessage({
        conversationId: conversation._id.toString(),
        role: 'assistant',
        content: "Hello! I'm here to help you with any questions or issues you might have. How can I assist you today?",
        source: 'assistant-first-message',
      });
    }

    return { id: conversation._id.toString() };
  }

  private async getConversationHistory(sessionId: string): Promise<ChatResponse> {
    // Get only recent messages (last 50 messages max) for performance
    const conversationMessages = await this.conversationDbService.getConversationMessages(sessionId, 1, 50);

    return {
      success: true,
      sessionId,
      userMessage: 'Conversation messages retrieved successfully',
      userMessageCode: 'CONVERSATION_MESSAGES_SUCCESS',
      developerMessage: 'Fetched conversation history',
      data: {
        result: {
          messages: conversationMessages,
          timestamp: new Date().toISOString(),
        },
      },
    };
  }

  private hasValidCredentials(credentials: any): boolean {
    if (!credentials) return false;

    // Check if any provider credentials exist
    const supportedProviders = ['openai', 'anthropic', 'groq', 'together-ai', 'anyscale', 'google'];
    return supportedProviders.some((provider) => credentials[`${provider}ApiKey`] || credentials[provider]);
  }

  private async getCredentialsForAssistant(
    assistantConfig: any,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, any> | null> {
    try {
      this.logger.log(`🔍 [CREDENTIALS] Getting credentials for assistant: ${assistantConfig.name}`);

      // Determine AI provider from assistant configuration
      const aiProvider = this.determineAIProvider(assistantConfig);
      this.logger.log(`🔍 [CREDENTIALS] Detected AI provider: ${aiProvider}`);

      if (!aiProvider) {
        this.logger.warn(`⚠️ [CREDENTIALS] No AI provider detected in assistant config`);
        return null;
      }

      // Fetch credentials for the specific provider
      const credentials = await this.getUserCredentials(userId, organizationId);

      if (!credentials) {
        this.logger.warn(`⚠️ [CREDENTIALS] No credentials found for user: ${userId}`);
        return null;
      }

      // Return credentials for the detected provider
      const providerCredentials: Record<string, any> = {};

      // Map provider names to credential field names
      const providerCredentialMap: Record<string, string> = {
        openai: 'openaiApiKey',
        anthropic: 'anthropicApiKey',
        groq: 'groqApiKey',
        'together-ai': 'togetherApiKey',
        anyscale: 'anyscaleApiKey',
        google: 'googleApiKey',
      };

      const credentialField = providerCredentialMap[aiProvider];
      if (credentialField && credentials[credentialField]) {
        providerCredentials[credentialField] = credentials[credentialField];
        this.logger.log(`✅ [CREDENTIALS] Found ${aiProvider} credentials`);
        return providerCredentials;
      } else {
        this.logger.warn(`⚠️ [CREDENTIALS] No ${aiProvider} credentials found for user`);
        return null;
      }
    } catch (error) {
      this.logger.error(`❌ [CREDENTIALS] Error getting credentials for assistant:`, error);
      return null;
    }
  }

  private determineAIProvider(assistantConfig: any): string | null {
    try {
      const supportedProviders = ['openai', 'anthropic', 'groq', 'together-ai', 'anyscale', 'google'];

      // Check modelConfig for provider information
      if (assistantConfig.modelConfig) {
        // Check if there's a provider field (most reliable)
        if (assistantConfig.modelConfig.provider) {
          const provider = assistantConfig.modelConfig.provider.toLowerCase();
          if (supportedProviders.includes(provider)) {
            return provider;
          }
        }

        // Check model name to infer provider
        if (assistantConfig.modelConfig.model) {
          const model = assistantConfig.modelConfig.model.toLowerCase();

          // OpenAI models
          if (model.includes('gpt') || model.includes('openai')) {
            return 'openai';
          }
          // Anthropic models
          else if (model.includes('claude') || model.includes('anthropic')) {
            return 'anthropic';
          }
          // Google models
          else if (model.includes('gemini') || model.includes('google')) {
            return 'google';
          }
          // Groq models
          else if (model.includes('groq') || model.includes('llama')) {
            return 'groq';
          }
          // Together AI models
          else if (model.includes('together') || model.includes('meta')) {
            return 'together-ai';
          }
          // Anyscale models
          else if (model.includes('anyscale') || model.includes('ray')) {
            return 'anyscale';
          }
        }

        // Check messages for system prompt hints
        if (assistantConfig.modelConfig.messages) {
          const systemMessage = assistantConfig.modelConfig.messages.find((msg: any) => msg.role === 'system');
          if (systemMessage && systemMessage.content) {
            const content = systemMessage.content.toLowerCase();
            for (const provider of supportedProviders) {
              if (content.includes(provider)) {
                return provider;
              }
            }
          }
        }
      }

      // Check templateCategory for hints
      if (assistantConfig.templateCategory) {
        const category = assistantConfig.templateCategory.toLowerCase();
        for (const provider of supportedProviders) {
          if (category.includes(provider)) {
            return provider;
          }
        }
      }

      // Default fallback - check assistant name
      if (assistantConfig.name) {
        const name = assistantConfig.name.toLowerCase();
        for (const provider of supportedProviders) {
          if (name.includes(provider)) {
            return provider;
          }
        }
      }

      this.logger.warn(`⚠️ [CREDENTIALS] Could not determine AI provider from assistant config`);
      return null;
    } catch (error) {
      this.logger.error(`❌ [CREDENTIALS] Error determining AI provider:`, error);
      return null;
    }
  }

  private async storeMessage(sessionId: string, role: 'user' | 'assistant', content: string, metadata?: any): Promise<any> {
    return await this.conversationDbService.sendMessage({
      conversationId: sessionId,
      role,
      content,
      source: role === 'user' ? 'user-input' : 'ai-response',
      processingTime: metadata?.processingTime || 0,
      cost: metadata?.cost,
      metadata: metadata || {},
    });
  }

  private async buildContext(sessionId: string, maxTokens: number): Promise<Array<{ role: string; content: string }>> {
    // Get only recent messages from current session (last 20 messages max)
    const conversationHistory = await this.conversationDbService.getConversationMessages(sessionId, 1, 20);

    // Filter out messages older than 24 hours for context
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentMessages = conversationHistory.filter((msg) => {
      const messageTime = new Date(msg.timestamp || msg.createdAt);
      return messageTime > twentyFourHoursAgo;
    });

    this.logger.log(`🔍 Context: ${recentMessages.length} recent messages (last 24h) from session ${sessionId}`);

    return recentMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  private async getAIResponse(
    message: string,
    context: any[],
    assistantConfig: any,
    credentials: any,
  ): Promise<{ content: string; cost: any; tokens: any; model: string }> {
    // Get AI response with token usage
    const aiResponse = await this.directAIService.getDirectAIResponseWithAssistantConfig(
      message,
      context,
      assistantConfig,
      undefined,
      credentials,
    );

    // Extract token usage from response
    const tokens = aiResponse.tokens || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    // Calculate cost breakdown with provider information for better model detection
    const model = assistantConfig.modelConfig?.model || 'gpt-3.5-turbo';
    const provider = assistantConfig.modelConfig?.provider || this.determineAIProvider(assistantConfig);
    const costBreakdown = this.costCalculationService.calculateCost(model, tokens, provider);

    this.logger.log(`💰 Cost breakdown: ${this.costCalculationService.formatCost(costBreakdown)}`);

    return {
      content: aiResponse.content,
      cost: {
        amount: costBreakdown.totalCost.amount,
        currency: costBreakdown.totalCost.currency,
        service: 'llm',
        modelCost: costBreakdown.modelCost.amount,
        platformCost: costBreakdown.platformCost.amount,
        breakdown: costBreakdown,
      },
      tokens: {
        prompt: tokens.promptTokens,
        completion: tokens.completionTokens,
        total: tokens.totalTokens,
      },
      model,
    };
  }

  private async streamAIResponse(
    message: string,
    context: any[],
    assistantConfig: any,
    credentials: any,
    sessionId: string,
  ): Promise<ChatResponse> {
    // TODO: Implement streaming response
    // For now, fall back to regular response
    const aiResponse = await this.getAIResponse(message, context, assistantConfig, credentials);
    await this.storeMessage(sessionId, 'assistant', aiResponse.content, {
      cost: aiResponse.cost,
      tokens: aiResponse.tokens,
      model: aiResponse.model,
      processingTime: Date.now(),
    });
    return this.successResponse(sessionId, aiResponse.content);
  }

  private successResponse(sessionId: string, message: string): ChatResponse {
    return {
      success: true,
      sessionId,
      userMessage: 'Message processed successfully',
      userMessageCode: 'MESSAGE_SUCCESS',
      developerMessage: 'Message processed successfully',
      data: {
        result: {
          message,
          timestamp: new Date().toISOString(),
        },
      },
    };
  }

  private errorResponse(userMessage: string, userMessageCode: string, sessionId: string | null = null): ChatResponse {
    return {
      success: false,
      sessionId,
      userMessage,
      userMessageCode,
      developerMessage: userMessage,
      data: { result: { timestamp: new Date().toISOString() } },
    };
  }

  /**
   * Get assistant configuration from User Service
   */
  private async getAssistantConfiguration(assistantId: string, organizationId: string, userId: string): Promise<any> {
    try {
      this.logger.log(`🔍 FETCHING ASSISTANT CONFIG - ID: ${assistantId}, User: ${userId}, Org: ${organizationId}`);

      // Forward request to User Service to get assistant details
      const response: any = await firstValueFrom(
        this.userServiceClient.send('getAssistantById', {
          requestedUser: { _id: userId }, // Use actual user ID from request
          assistantId,
          organizationId, // Include organization ID
        }),
      );

      this.logger.log(`🔍 Assistant config response:`, JSON.stringify(response, null, 2));

      if (!response.data || !response.data.result) {
        this.logger.error(`❌ No assistant data in response:`, response);
        throw new Error(`Failed to get assistant configuration: ${response.userMessage || 'Unknown error'}`);
      }

      this.logger.log(`✅ Assistant config retrieved: ${response.data.result.name}`);
      return response.data.result;
    } catch (error) {
      this.logger.error(`❌ [ASSISTANT SERVICE SMART MESSAGE] Error getting assistant config:`, error);
      // Return default config if assistant not found
      return {
        name: 'Default Assistant',
        templateCategory: 'general',
        modelConfig: {
          messages: [
            {
              role: 'system',
              content: 'You are a helpful AI assistant. Please provide accurate and helpful responses.',
            },
          ],
          temperature: 0.7,
          maxTokens: 250,
        },
      };
    }
  }

  /**
   * Get system credentials from environment variables
   */
  private getSystemCredentials(): Record<string, any> | null {
    try {
      const aiProvider = process.env.AI_PROVIDER?.toLowerCase();

      if (!aiProvider) {
        this.logger.warn(`⚠️ [SYSTEM CREDENTIALS] AI_PROVIDER not set in environment`);
        return null;
      }

      const credentials: Record<string, any> = {};

      if (aiProvider === 'google') {
        const googleApiKey = process.env.GOOGLE_API_KEY;
        const googleModel = process.env.GOOGLE_AI_MODEL;

        if (googleApiKey) {
          credentials.googleApiKey = googleApiKey;
          if (googleModel) {
            credentials.googleModel = googleModel;
          }
          this.logger.log(`✅ [SYSTEM CREDENTIALS] Found Google credentials`);
          return credentials;
        }
      } else if (aiProvider === 'openai') {
        const openaiApiKey = process.env.OPENAI_API_KEY;
        const openaiModel = process.env.OPENAI_MODEL;

        if (openaiApiKey) {
          credentials.openaiApiKey = openaiApiKey;
          if (openaiModel) {
            credentials.openaiModel = openaiModel;
          }
          this.logger.log(`✅ [SYSTEM CREDENTIALS] Found OpenAI credentials`);
          return credentials;
        }
      }

      this.logger.warn(`⚠️ [SYSTEM CREDENTIALS] No valid credentials found for provider: ${aiProvider}`);
      return null;
    } catch (error) {
      this.logger.error(`❌ [SYSTEM CREDENTIALS] Error getting system credentials:`, error);
      return null;
    }
  }

  /**
   * Get provider credentials for AI providers
   */
  private async getUserCredentials(userId: string, organizationId: string): Promise<Record<string, any> | null> {
    try {
      this.logger.log(`🔑 [ASSISTANT SERVICE SMART MESSAGE] Fetching provider credentials for: ${userId}`);

      // Request ALL provider credentials from User Service (not just OpenAI)
      const response: any = await firstValueFrom(
        this.userServiceClient.send('getProviderCredentials', {
          organizationId,
          requestingUserId: userId,
          userId: userId,
          // Don't specify providerName to get all LLM credentials
          serviceType: 'llm',
        }),
      );

      console.log(`🔑 [ASSISTANT SERVICE SMART MESSAGE] Provider credentials response:`, response);

      if (!response.success || !response.data || !response.data.result) {
        this.logger.log(`🔑 [ASSISTANT SERVICE SMART MESSAGE] No provider credentials found`);
        return null;
      }

      const credentials = response.data.result;
      this.logger.log(`🔑 [ASSISTANT SERVICE SMART MESSAGE] Provider credentials retrieved successfully`);

      // Transform provider credentials to the format expected by DirectAIService
      const transformedCredentials: Record<string, any> = {};

      // Map all supported providers
      const supportedProviders = ['openai', 'anthropic', 'groq', 'together-ai', 'anyscale', 'google'];
      const providerCredentialMap: Record<string, string> = {
        openai: 'openaiApiKey',
        anthropic: 'anthropicApiKey',
        groq: 'groqApiKey',
        'together-ai': 'togetherApiKey',
        anyscale: 'anyscaleApiKey',
        google: 'googleApiKey',
      };

      // Check for all provider credentials
      if (credentials.llm && credentials.llm.length > 0) {
        this.logger.log(`🔑 Found ${credentials.llm.length} LLM credentials`);
        for (const provider of supportedProviders) {
          const credential = credentials.llm.find((cred: any) => cred.providerName === provider);
          if (credential && credential.credentials && credential.credentials.apiKey) {
            const credentialField = providerCredentialMap[provider];
            transformedCredentials[credentialField] = credential.credentials.apiKey;
            this.logger.log(`🔑 Found ${provider} credentials`);
          }
        }
      } else {
        this.logger.warn(`⚠️ No LLM credentials found in response`);
      }

      return Object.keys(transformedCredentials).length > 0 ? transformedCredentials : null;
    } catch (error) {
      this.logger.error(`❌ [ASSISTANT SERVICE SMART MESSAGE] Error getting provider credentials:`, error);
      return null;
    }
  }

  /**
   * Find existing session by session key
   */
  private async findExistingSession(sessionKey: string): Promise<any> {
    try {
      this.logger.log(`🔍 [ASSISTANT SERVICE SMART MESSAGE] Looking for existing session: ${sessionKey}`);

      // Parse session key to extract userId, assistantId, organizationId
      const [userId, assistantId, organizationId] = sessionKey.split('_');

      if (!userId || !assistantId || !organizationId) {
        this.logger.warn(`⚠️ [ASSISTANT SERVICE SMART MESSAGE] Invalid session key format: ${sessionKey}`);
        return null;
      }

      // Query database for active chat conversations with matching criteria
      const result = await this.conversationDbService.getConversationsByType(
        organizationId,
        'chat',
        1, // page 1
        1, // limit 1
      );

      // Find the most recent active conversation for this user-assistant combination
      const activeConversation = result.conversations.find(
        (conv) => conv.userId?.toString() === userId && conv.assistantId?.toString() === assistantId && conv.status === 'active',
      );

      if (activeConversation) {
        this.logger.log(`✅ [ASSISTANT SERVICE SMART MESSAGE] Found existing active session: ${activeConversation._id}`);
        return activeConversation;
      } else {
        this.logger.log(`ℹ️ [ASSISTANT SERVICE SMART MESSAGE] No active session found for key: ${sessionKey}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`❌ [ASSISTANT SERVICE SMART MESSAGE] Error finding existing session:`, error);
      return null;
    }
  }

  /**
   * Get fallback AI response for KB comparison
   */
  private async getFallbackAIResponse(
    message: string,
    assistantConfig: any,
    credentials: any,
  ): Promise<{ content: string; cost: any; tokens: any; model: string }> {
    try {
      // Build minimal context for fallback response
      const context = await this.buildContext('', assistantConfig.modelConfig?.maxTokens || 4000);

      // Get AI response using the same method as normal flow
      const aiResponse = await this.getAIResponse(message, context, assistantConfig, credentials);

      return aiResponse;
    } catch (error) {
      this.logger.warn(`Failed to get fallback AI response: ${error.message}`);
      return {
        content: 'I apologize, but I encountered an error processing your request.',
        cost: { amount: 0, currency: 'USD', service: 'llm' },
        tokens: { prompt: 0, completion: 0, total: 0 },
        model: 'error',
      };
    }
  }
}
