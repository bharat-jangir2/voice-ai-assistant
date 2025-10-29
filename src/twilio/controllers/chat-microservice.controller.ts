import { Controller, Logger, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
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
      const sessionAge = Date.now() - new Date(conversation.createdAt).getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (sessionAge > twentyFourHours) {
        this.logger.log(`🔄 [SESSION] Session expired, creating new one for ${sessionKey}`);
        conversation = null; // Force creation of new session
      } else {
        this.logger.log(`✅ [SESSION] Using existing active session: ${conversation._id}`);
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
        1, // limit to 1
        0, // offset 0
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
