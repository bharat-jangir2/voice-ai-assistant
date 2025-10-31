import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as path from 'path';
import { ConversationLoggerService } from './conversation-logger.service';
import { TokenUsage } from './cost-calculation.service';

// AI Provider interface for abstraction
interface AIProvider {
  invoke(prompt: string): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }>;
  invokeWithMessages(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }>;
}

// OpenAI Provider implementation
class OpenAIProvider implements AIProvider {
  private model: OpenAI;

  constructor(apiKey: string) {
    this.model = new OpenAI({
      apiKey: apiKey,
    });
  }

  async invoke(prompt: string): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }> {
    const response = await this.model.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful AI assistant.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
    });

    const tokens: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    };

    return {
      content: response.choices[0]?.message?.content || '',
      rawResponse: response,
      tokens,
    };
  }

  async invokeWithMessages(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }> {
    const response = await this.model.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messages as any, // Type assertion to handle OpenAI's strict typing
      temperature: 0.7,
    });

    const tokens: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    };

    return {
      content: response.choices[0]?.message?.content || '',
      rawResponse: response,
      tokens,
    };
  }
}

// Google Gemini Provider implementation
class GoogleGeminiProvider implements AIProvider {
  private model: any;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: process.env.GOOGLE_AI_MODEL as string });
  }

  async invoke(prompt: string): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }> {
    const result = await this.model.generateContent(prompt);
    const response = await result.response;

    // Extract token usage from Gemini response
    // Google Gemini returns usageMetadata in result.response.candidates[0].usageMetadata or result.response.usageMetadata
    const usageMetadata = result.response.usageMetadata || (result.response.candidates?.[0] as any)?.usageMetadata;
    const tokens: TokenUsage = {
      promptTokens: usageMetadata?.promptTokenCount || 0,
      completionTokens: usageMetadata?.candidatesTokenCount || 0,
      totalTokens: usageMetadata?.totalTokenCount || 0,
    };

    return {
      content: response.text(),
      rawResponse: result.response,
      tokens,
    };
  }

  async invokeWithMessages(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }> {
    // Convert messages array to prompt format for Gemini
    let prompt = '';

    messages.forEach((msg) => {
      if (msg.role === 'system') {
        prompt += `SYSTEM INSTRUCTIONS: ${msg.content}\n\n`;
      } else if (msg.role === 'user') {
        prompt += `User: ${msg.content}\n`;
      } else if (msg.role === 'assistant') {
        prompt += `Assistant: ${msg.content}\n`;
      }
    });

    const result = await this.model.generateContent(prompt);
    const response = await result.response;

    // Extract token usage from Gemini response
    const usageMetadata = result.response.usageMetadata || (result.response.candidates?.[0] as any)?.usageMetadata;
    const tokens: TokenUsage = {
      promptTokens: usageMetadata?.promptTokenCount || 0,
      completionTokens: usageMetadata?.candidatesTokenCount || 0,
      totalTokens: usageMetadata?.totalTokenCount || 0,
    };

    return {
      content: response.text(),
      rawResponse: result.response,
      tokens,
    };
  }
}

@Injectable()
export class DirectAIService {
  private readonly logger = new Logger(DirectAIService.name);
  private readonly aiProvider: AIProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly conversationLogger: ConversationLoggerService,
  ) {
    // Initialize AI Provider based on environment variable
    const aiProvider = this.configService.get('AI_PROVIDER') || 'GOOGLE';
    const openaiApiKey = this.configService.get('OPENAI_API_KEY');
    const geminiApiKey = this.configService.get('GOOGLE_API_KEY');

    if (aiProvider === 'OPENAI') {
      if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY is required when AI_PROVIDER is set to openai');
      }
      this.aiProvider = new OpenAIProvider(openaiApiKey);
      this.logger.log(`Initialized OpenAI provider (${process.env.OPENAI_MODEL})`);
    } else {
      // Default to Google (Gemini)
      if (!geminiApiKey) {
        throw new Error('GOOGLE_API_KEY is required for Google Gemini provider');
      }
      this.aiProvider = new GoogleGeminiProvider(geminiApiKey);
      this.logger.log(`Initialized Google Gemini provider (${process.env.GOOGLE_AI_MODEL})`);
    }
  }

  // Generate direct AI response with assistant-specific configuration and dynamic credentials
  async getDirectAIResponseWithAssistantConfig(
    question: string,
    contextMessages: Array<{ role: string; content: string }>,
    assistantConfig: any,
    sessionId?: string,
    userCredentials?: Record<string, any>,
  ): Promise<{ content: string; rawResponse?: any; tokens?: TokenUsage }> {
    try {
      this.logger.log(`🔍 [DIRECT AI WITH ASSISTANT CONFIG] Starting response generation for session: ${sessionId}`);
      this.logger.log(`🔍 [DIRECT AI WITH ASSISTANT CONFIG] Question: "${question}"`);
      this.logger.log(
        `🔍 [DIRECT AI WITH ASSISTANT CONFIG] Assistant: ${assistantConfig.name} (${assistantConfig.templateCategory || 'custom'})`,
      );
      this.logger.log(`🔍 [DIRECT AI WITH ASSISTANT CONFIG] Context messages: ${contextMessages.length}`);

      this.logger.log(`🔍 Assistant config: ${JSON.stringify(assistantConfig, null, 2)}`);

      // Extract system prompt from assistant configuration
      const systemMessage = assistantConfig.modelConfig?.messages?.find((msg: any) => msg.role === 'system');
      const systemPrompt =
        systemMessage?.content || 'You are a helpful AI assistant. Please provide accurate and helpful responses.';

      this.logger.log(`🔍 System prompt: "${systemPrompt}"`);

      // Build messages array with proper system prompt
      const messages = [
        {
          role: 'system',
          content: systemPrompt,
        },
      ];

      // Add conversation context if available
      if (contextMessages && contextMessages.length > 0) {
        // Only include the last 5 messages to maintain context without overwhelming
        const recentMessages = contextMessages.slice(-5);
        recentMessages.forEach((msg) => {
          if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({
              role: msg.role,
              content: msg.content,
            });
          }
        });
      }

      // Add the current user question
      messages.push({
        role: 'user',
        content: question,
      });

      // Convert messages to prompt format for providers that don't support message arrays
      let prompt = `${systemPrompt}

User: ${question}`;

      // Add conversation context if available
      if (contextMessages && contextMessages.length > 0) {
        prompt += `\n\nPrevious conversation:\n`;
        const recentMessages = contextMessages.slice(-3);
        recentMessages.forEach((msg) => {
          if (msg.role === 'user') {
            prompt += `User: ${msg.content}\n`;
          } else if (msg.role === 'assistant') {
            prompt += `Assistant: ${msg.content}\n`;
          }
        });
      }

      // Use dynamic credentials if provided, otherwise use default AI provider
      // For testing: AI_PROVIDER env var takes precedence over user credentials
      let aiProvider = this.aiProvider;

      // Check if AI_PROVIDER is set in environment (for testing purposes)
      const preferredProvider = this.configService.get('AI_PROVIDER')?.toUpperCase();
      this.logger.debug(`🔍 AI_PROVIDER environment variable: ${preferredProvider}`);

      if (preferredProvider) {
        // For testing: Use system credentials from AI_PROVIDER, ignore user credentials
        if (preferredProvider === 'GOOGLE') {
          const googleApiKey = this.configService.get('GOOGLE_API_KEY');
          if (googleApiKey) {
            aiProvider = new GoogleGeminiProvider(googleApiKey);
            this.logger.log(`🔑 Using Google AI credentials from environment (AI_PROVIDER=GOOGLE)`);
          } else {
            this.logger.warn(`⚠️ AI_PROVIDER=GOOGLE but GOOGLE_API_KEY not found, falling back to default`);
          }
        } else if (preferredProvider === 'OPENAI') {
          const openaiApiKey = this.configService.get('OPENAI_API_KEY');
          if (openaiApiKey) {
            aiProvider = new OpenAIProvider(openaiApiKey);
            this.logger.log(`🔑 Using OpenAI credentials from environment (AI_PROVIDER=OPENAI)`);
          } else {
            this.logger.warn(`⚠️ AI_PROVIDER=OPENAI but OPENAI_API_KEY not found, falling back to default`);
          }
        }
      } else if (userCredentials) {
        // If AI_PROVIDER not set, check user credentials (backward compatibility)
        if (userCredentials.openaiApiKey) {
          aiProvider = new OpenAIProvider(userCredentials.openaiApiKey);
          this.logger.log(`🔑 Using OpenAI credentials from user/org credentials`);
        } else if (userCredentials.googleApiKey) {
          aiProvider = new GoogleGeminiProvider(userCredentials.googleApiKey);
          this.logger.log(`🔑 Using Google AI credentials from user/org credentials`);
        } else {
          this.logger.log(`🔑 No valid user credentials found, using default provider`);
        }
      } else {
        this.logger.log(`🔑 No user credentials provided, using default provider`);
      }

      this.logger.log(`🔍 Using AI provider: ${aiProvider.constructor.name}`);

      // Use messages array for better system prompt handling
      const response = await aiProvider.invokeWithMessages(messages);

      if (response.tokens) {
        this.logger.log(
          `💰 Token usage: ${response.tokens.promptTokens} prompt + ${response.tokens.completionTokens} completion = ${response.tokens.totalTokens} total`,
        );
      }

      return response;
    } catch (error) {
      this.logger.error('❌ [DIRECT AI WITH ASSISTANT CONFIG] Error in direct AI response with assistant config:', error);
      throw error;
    }
  }

  // Generate direct AI response with conversation context
  async getDirectAIResponseWithContext(
    question: string,
    contextMessages: Array<{ role: string; content: string }>,
    assistantType: string = 'general',
    sessionId?: string,
  ): Promise<string> {
    try {
      this.logger.log(`🔍 [DIRECT AI WITH CONTEXT] Starting response generation for session: ${sessionId}`);
      this.logger.log(`🔍 [DIRECT AI WITH CONTEXT] Question: "${question}"`);
      this.logger.log(`🔍 [DIRECT AI WITH CONTEXT] Context messages: ${contextMessages.length}`);

      // Load assistant-specific prompt instructions
      const assistantInstructions = await this.loadAssistantPrompt(assistantType);
      this.logger.log(`🔍 [DIRECT AI WITH CONTEXT] Loaded assistant instructions: ${assistantInstructions.substring(0, 100)}...`);

      // Build context-aware prompt
      let prompt = `${assistantInstructions}

IMPORTANT: You are having a conversation with a user. Use the conversation history below to provide context-aware responses. You can reference information the user has shared during this conversation.`;

      // Add conversation context
      if (contextMessages && contextMessages.length > 0) {
        prompt += `\n\nConversation History:\n`;
        contextMessages.forEach((msg, index) => {
          if (msg.role === 'user') {
            prompt += `User: ${msg.content}\n`;
          } else if (msg.role === 'assistant') {
            prompt += `Assistant: ${msg.content}\n`;
          }
        });
        prompt += `\nCurrent User Question: ${question}`;
        prompt += `\n\nPlease respond naturally considering the conversation context above. You can use information the user has shared during this conversation to answer their questions. If the current question relates to previous topics or information shared by the user, you can reference that information.`;
      } else {
        prompt += `\n\nCurrent User Question: ${question}`;
        prompt += `\n\nSince there's no conversation context, respond naturally saying that you don't have specific information about this topic in your knowledge base, but you're happy to help with other questions that are available.`;
      }

      prompt += `\n\nProvide your response in a natural, conversational way.`;

      this.logger.log(`🔍 [DIRECT AI WITH CONTEXT] Generated prompt length: ${prompt.length} characters`);
      this.logger.log(`🔍 [DIRECT AI WITH CONTEXT] Prompt preview: ${prompt.substring(0, 200)}...`);

      const response = await this.aiProvider.invoke(prompt);
      this.logger.log(`✅ [DIRECT AI WITH CONTEXT] AI Response: "${response.content}"`);

      return response.content;
    } catch (error) {
      this.logger.error('❌ [DIRECT AI WITH CONTEXT] Error in direct AI response with context:', error);
      throw error;
    }
  }

  // Generate direct AI response without database lookup
  async getDirectAIResponse(question: string, assistantType: string = 'general', sessionId?: string): Promise<string> {
    try {
      this.logger.log(`🔍 [DIRECT AI] Starting response generation for session: ${sessionId}`);
      this.logger.log(`🔍 [DIRECT AI] Question: "${question}"`);
      this.logger.log(`🔍 [DIRECT AI] Assistant Type: ${assistantType}`);

      // Load assistant-specific prompt instructions
      const assistantInstructions = await this.loadAssistantPrompt(assistantType);
      this.logger.log(`🔍 [DIRECT AI] Loaded assistant instructions: ${assistantInstructions.substring(0, 100)}...`);

      // For general assistant, check if question matches data.json
      // Skip data.json checking for booking assistant to allow pure AI processing
      if (assistantType === 'general') {
        this.logger.log(`🔍 [DIRECT AI] Checking data.json for exact match...`);
        const dataAnswer = await this.getAnswerFromData(question, assistantType);
        if (dataAnswer) {
          this.logger.log(`✅ [DIRECT AI] Found exact match in data.json: "${dataAnswer}"`);
          return dataAnswer;
        } else {
          this.logger.log(`❌ [DIRECT AI] No exact match found in data.json`);
        }
      } else if (assistantType === 'booking') {
        this.logger.log(`📋 [DIRECT AI] Booking mode: Skipping data.json check, using pure AI processing`);
      }

      // Get conversation history for context
      this.logger.log(`🔍 [DIRECT AI] Retrieving conversation history for session: ${sessionId}`);
      const conversationHistory = await this.getConversationHistory(sessionId);

      if (conversationHistory && conversationHistory.length > 0) {
        this.logger.log(`✅ [DIRECT AI] Found ${conversationHistory.length} previous interactions:`);
        conversationHistory.forEach((interaction, index) => {
          this.logger.log(`   ${index + 1}. Q: "${interaction.question}"`);
          this.logger.log(`      A: "${interaction.answer}"`);
        });
      } else {
        this.logger.log(`❌ [DIRECT AI] No conversation history found`);
      }

      // Build context-aware prompt
      let prompt = `${assistantInstructions}

      IMPORTANT: This question is not in your predefined knowledge base. However, you can use information from the conversation context below to answer questions about what the user has told you during this conversation.`;

      // Add conversation context if available
      if (conversationHistory && conversationHistory.length > 0) {
        prompt += `\n\nConversation Context:\n`;
        conversationHistory.forEach((interaction, index) => {
          prompt += `${index + 1}. User: ${interaction.question}\n`;
          prompt += `   Assistant: ${interaction.answer}\n`;
        });
        prompt += `\nCurrent Question: ${question}`;
        prompt += `\n\nPlease respond naturally considering the conversation context above. You can use information the user has shared during this conversation to answer their questions. If the current question relates to previous topics or information shared by the user, you can reference that information.`;
      } else {
        prompt += `\n\nQuestion: ${question}`;
        prompt += `\n\nSince there's no conversation context, respond naturally saying that you don't have specific information about this topic in your knowledge base, but you're happy to help with other questions that are available.`;
      }

      prompt += `\n\nProvide your response in a natural, conversational way suitable for a phone conversation.`;

      this.logger.log(`🔍 [DIRECT AI] Generated prompt length: ${prompt.length} characters`);
      this.logger.log(`🔍 [DIRECT AI] Prompt preview: ${prompt.substring(0, 200)}...`);

      const response = await this.aiProvider.invoke(prompt);
      this.logger.log(`✅ [DIRECT AI] AI Response: "${response.content}"`);

      return response.content;
    } catch (error) {
      this.logger.error('❌ [DIRECT AI] Error in direct AI response:', error);
      throw error;
    }
  }

  // Load assistant-specific prompt instructions from JSON files
  private async loadAssistantPrompt(assistantType: string): Promise<string> {
    try {
      const promptPath = path.join(__dirname, '..', '..', '..', 'src', 'twilio', 'assistant', assistantType, 'prompt.json');
      const fs = require('fs');
      const promptData = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
      return promptData.prompt || promptData.instructions || 'You are a helpful assistant.';
    } catch (error) {
      this.logger.warn(`Could not load prompt for assistant type: ${assistantType}, using default prompt`);
      return 'You are a helpful assistant. Please provide accurate and helpful responses.';
    }
  }

  // Check if question matches data.json using AI-powered semantic matching
  private async getAnswerFromData(question: string, assistantType: string): Promise<string | null> {
    try {
      const dataPath = path.join(__dirname, '..', '..', '..', 'src', 'twilio', 'assistant', assistantType, 'data.json');
      const fs = require('fs');
      const dataContent = fs.readFileSync(dataPath, 'utf8');
      const qaData = JSON.parse(dataContent);

      this.logger.log(`🔍 [AI DATA MATCH] Using AI to find semantic match for: "${question}"`);

      // Create a prompt for AI to find the best matching question
      const questionsList = qaData.map((item, index) => `${index + 1}. "${item.question}"`).join('\n');

      const matchingPrompt = `
      You are a smart question matcher. I have a user question and a list of predefined questions with answers.

      USER QUESTION: "${question}"

      PREDEFINED QUESTIONS:
      ${questionsList}

      INSTRUCTIONS:
      1. Analyze the user's question and understand its intent/meaning
      2. Find the BEST matching question from the predefined list that has the SAME INTENT
      3. If you find a match, respond with ONLY the number (1, 2, 3, etc.) of the matching question
      4. If NO question matches the intent, respond with "NO_MATCH"

      EXAMPLES:
      - User: "can you tell me a joke" → Should match "Tell me a small joke" → Respond: "1"
      - User: "I want to hear a joke" → Should match "Tell me a small joke" → Respond: "1" 
      - User: "what's a funny joke?" → Should match "Tell me a small joke" → Respond: "1"
      - User: "what is the weather?" → No joke questions match → Respond: "NO_MATCH"

      RESPOND WITH ONLY THE NUMBER OR "NO_MATCH":`;

      // Use AI to find the best match
      const matchResult = await this.aiProvider.invoke(matchingPrompt);
      const matchResponse = matchResult.content.trim();

      this.logger.log(`🤖 [AI DATA MATCH] AI response: "${matchResponse}"`);

      // Check if AI found a match
      const matchNumber = parseInt(matchResponse);
      if (!isNaN(matchNumber) && matchNumber >= 1 && matchNumber <= qaData.length) {
        const matchedItem = qaData[matchNumber - 1];
        this.logger.log(`✅ [AI DATA MATCH] Found semantic match: "${matchedItem.question}" -> "${matchedItem.answer}"`);
        return matchedItem.answer;
      }

      // No match found
      this.logger.log(`❌ [AI DATA MATCH] No semantic match found for: "${question}"`);
      return null;
    } catch (error) {
      this.logger.warn(`Could not perform AI data matching for assistant type: ${assistantType}`, error);
      return null;
    }
  }

  // Get conversation history for context-aware responses
  private async getConversationHistory(sessionId?: string): Promise<Array<{ question: string; answer: string }> | null> {
    if (!sessionId) {
      this.logger.log(`🔍 [CONVERSATION HISTORY] No sessionId provided`);
      return null;
    }

    try {
      this.logger.log(`🔍 [CONVERSATION HISTORY] Retrieving session: ${sessionId}`);

      // Get session from conversation logger
      const session = await this.conversationLogger.getSession(sessionId);

      if (!session) {
        this.logger.log(`❌ [CONVERSATION HISTORY] Session not found: ${sessionId}`);
        return null;
      }

      if (!session.interactions || session.interactions.length === 0) {
        this.logger.log(`❌ [CONVERSATION HISTORY] No interactions found in session: ${sessionId}`);
        return null;
      }

      this.logger.log(`✅ [CONVERSATION HISTORY] Found ${session.interactions.length} total interactions in session`);

      // Get last 5 interactions for context (to avoid too long prompts)
      const recentInteractions = session.interactions.slice(-5);
      this.logger.log(`🔍 [CONVERSATION HISTORY] Using last ${recentInteractions.length} interactions for context`);

      const history = recentInteractions.map((interaction) => ({
        question: interaction.question,
        answer: interaction.answer || 'No answer available',
      }));

      this.logger.log(`✅ [CONVERSATION HISTORY] Returning conversation history:`, history);
      return history;
    } catch (error) {
      this.logger.warn(`❌ [CONVERSATION HISTORY] Could not retrieve conversation history for session ${sessionId}:`, error);
      return null;
    }
  }
}
