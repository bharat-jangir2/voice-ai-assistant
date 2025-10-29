import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { CollectionInfo, QdrantDocument, QdrantPoint, QdrantSearchResult } from '../interfaces/qdrant.interfaces';
import { ConversationLoggerService } from './conversation-logger.service';
import { EmbeddingService } from './embedding.service';

// AI Provider interface for abstraction
interface AIProvider {
  invoke(prompt: string): Promise<{ content: string }>;
}

// OpenAI Provider implementation
class OpenAIProvider implements AIProvider {
  private model: OpenAI;

  constructor(apiKey: string) {
    this.model = new OpenAI({
      apiKey: apiKey,
    });
  }

  async invoke(prompt: string): Promise<{ content: string }> {
    const response = await this.model.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful AI assistant.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
    });
    return {
      content: response.choices[0]?.message?.content || '',
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

  async invoke(prompt: string): Promise<{ content: string }> {
    const result = await this.model.generateContent(prompt);
    const response = await result.response;
    return {
      content: response.text(),
    };
  }
}

@Injectable()
export class QdrantDBService {
  private readonly logger = new Logger(QdrantDBService.name);
  private readonly qdrantUrl: string;
  private readonly aiProvider: AIProvider;
  private readonly vectorSize: number = 384; // Sentence transformer embedding dimension (Xenova/all-MiniLM-L6-v2)
  private readonly highConfidenceScore: number; // Configurable high confidence threshold for Qdrant
  private readonly lowConfidenceScore: number; // Configurable low confidence threshold for Qdrant

  constructor(
    private readonly configService: ConfigService,
    private readonly conversationLogger: ConversationLoggerService,
    private readonly embeddingService: EmbeddingService,
  ) {
    // Initialize Qdrant URL
    this.qdrantUrl = this.configService.get('QDRANT_DB_URL') || 'http://localhost:6333';
    this.logger.log(`QdrantDBService initialized with URL: ${this.qdrantUrl}`);

    // Initialize confidence score thresholds
    this.highConfidenceScore = this.configService.get<number>('QDRANT_HIGH_CONFIDENCE_SCORE') || 0.5;
    this.lowConfidenceScore = this.configService.get<number>('QDRANT_LOW_CONFIDENCE_SCORE') || 0.2;
    this.logger.log(
      `QdrantDBService initialized with high confidence score threshold: ${this.highConfidenceScore}, low confidence score threshold: ${this.lowConfidenceScore}`,
    );

    // Initialize AI Provider based on environment variable
    const aiProvider = this.configService.get('AI_PROVIDER') || 'GOOGLE';
    const openaiApiKey = this.configService.get('OPENAI_API_KEY');
    const geminiApiKey = this.configService.get('GOOGLE_API_KEY');

    if (aiProvider === 'OPENAI') {
      if (!openaiApiKey) {
        this.logger.error('OPENAI_API_KEY not found in environment variables');
        throw new Error('OPENAI_API_KEY is required when AI_PROVIDER is set to openai');
      }
      this.aiProvider = new OpenAIProvider(openaiApiKey);
      this.logger.log(`Initialized OpenAI provider (${process.env.OPENAI_MODEL})`);
    } else {
      // Default to Google (Gemini)
      if (!geminiApiKey) {
        this.logger.error('GOOGLE_API_KEY not found in environment variables');
        throw new Error('GOOGLE_API_KEY is required for Google Gemini provider');
      }
      this.aiProvider = new GoogleGeminiProvider(geminiApiKey);
      this.logger.log(`Initialized Google Gemini provider (${process.env.GOOGLE_AI_MODEL}`);
    }
  }

  // Create Qdrant collection with vector configuration if it doesn't exist
  async createCollectionIfNotExists(collectionName: string): Promise<void> {
    try {
      const response = await fetch(`${this.qdrantUrl}/collections/${collectionName}`);

      if (response.status === 404) {
        // Collection doesn't exist, create it
        const createResponse = await fetch(`${this.qdrantUrl}/collections/${collectionName}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            vectors: {
              size: this.vectorSize,
              distance: 'Cosine',
            },
          }),
        });

        if (!createResponse.ok) {
          throw new Error(`Failed to create collection: ${createResponse.statusText}`);
        }

        this.logger.log(`Created Qdrant collection: ${collectionName}`);
      } else if (!response.ok) {
        throw new Error(`Failed to check collection: ${response.statusText}`);
      }
    } catch (error) {
      this.logger.error(`Error creating collection ${collectionName}:`, error);
      throw error;
    }
  }

  // Search for semantically similar documents using vector similarity
  async findRelevantDocuments(query: string, collectionName: string): Promise<{ content: string; score: number }[]> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);

      // Search for similar documents
      const searchResponse = await fetch(`${this.qdrantUrl}/collections/${collectionName}/points/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vector: queryEmbedding,
          limit: 3,
          with_payload: true,
        }),
      });

      if (!searchResponse.ok) {
        throw new Error(`Search failed: ${searchResponse.statusText}`);
      }

      const searchResult = await searchResponse.json();
      const results: QdrantSearchResult[] = searchResult.result || [];

      const contentWithScore = results.map((result) => ({
        content: result.payload.content || '',
        score: result.score || 0,
      }));

      // Extract document contents
      // return results.map((result) => result.payload.content || '');
      return contentWithScore;
    } catch (error) {
      // Handle errors gracefully
      this.logger.warn('Error while searching Qdrant database. Context not found.');
      this.logger.debug('Error details:', error.message);
      return [];
    }
  }

  // Load assistant-specific prompt instructions from JSON files
  private async loadAssistantPrompt(assistantType: string): Promise<string> {
    try {
      const promptPath = path.join(__dirname, '..', '..', '..', 'src', 'twilio', 'assistant', assistantType, 'prompt.json');

      if (!fs.existsSync(promptPath)) {
        this.logger.warn(`Prompt file not found for assistant type: ${assistantType}. Using default prompt.`);
        return `You are a professional telephony AI assistant. Your task is to provide clear, concise, and natural-sounding responses based on the given context.

        Rules:
        1. Use the exact information from the context
        2. Maintain a professional and friendly tone
        3. If the answer is in the context, provide it in a complete sentence
        4. If the answer is not in the context, acknowledge the question topic and explain you can't help with that specific information
        5. Never make up or infer information not present in the context
        6. Prioritize clarity and brevity in responses`;
      }

      const promptData = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
      return promptData.instructions || '';
    } catch (error) {
      this.logger.error(`Error loading prompt for assistant type ${assistantType}:`, error);
      throw new Error(`Failed to load prompt for assistant type: ${assistantType}`);
    }
  }

  // Generate AI response using RAG with vector search and conversation logging
  async getAnswerUsingQdrantRAG(
    question: string,
    assistantType: string = 'general',
    sessionId?: string,
    confidence?: number,
    phoneNumber?: string,
  ): Promise<string> {
    // Create or get conversation session
    const session = this.conversationLogger.getOrCreateSession(sessionId || 'unknown', assistantType, phoneNumber);

    // Create interaction for this Q&A
    const interaction = this.conversationLogger.createInteraction(question, false);

    try {
      // Find relevant documents with timing
      const searchStartTime = Date.now();
      const relevantDocs = await this.findRelevantDocuments(question, assistantType);
      const searchTime = Date.now() - searchStartTime;

      this.logger.verbose(
        `\n✅ ${relevantDocs.length} Context Documents fetched from QdrantDB
           Time taken: ${searchTime}ms
           Documents: ${JSON.stringify(relevantDocs, null, 2)}
        `,
      );

      let responseText: string;
      let modelUsed: string;

      // CASE 1: At least one relevant doc with score >= highConfidenceScore
      const highConfidenceDoc = relevantDocs.find((doc) => doc.score >= this.highConfidenceScore);
      if (highConfidenceDoc) {
        const answerMatch = highConfidenceDoc.content.match(/Answer:\s*(.+)/);
        responseText = answerMatch?.[1]?.trim() || "I found some information but couldn't extract a specific answer.";

        this.logger.verbose(`
        ✅ Answer directly from Qdrant (score >= ${this.highConfidenceScore})
           Question: ${question}
           Answer  : "${responseText}"
      `);

        modelUsed = 'qdrant-db-direct';

        // Update interaction with high confidence response
        this.conversationLogger.updateAnswer(interaction, responseText);
        this.conversationLogger.updateSourceQdrantHighConfidence(interaction, [
          {
            content: highConfidenceDoc.content,
            score: highConfidenceDoc.score,
          },
        ]);
      } else {
        // CASE 2: Check for docs with score >= lowConfidenceScore but < highConfidenceScore
        const mediumConfidenceDocs = relevantDocs.filter(
          (doc) => doc.score >= this.lowConfidenceScore && doc.score < this.highConfidenceScore,
        );

        if (mediumConfidenceDocs.length > 0) {
          // Use GPT with context for medium confidence docs
          const assistantInstructions = await this.loadAssistantPrompt(assistantType);
          const context = mediumConfidenceDocs.map((doc) => doc.content).join('\n---\n');

          const prompt = `${assistantInstructions}

      Context:
      ${context}

      Question: ${question}

      Please provide your response in a natural, conversational way suitable for a phone conversation.`;

          const responseStartTime = Date.now();
          const response = await this.aiProvider.invoke(prompt);
          const responseTime = Date.now() - responseStartTime;

          responseText = response.content;
          modelUsed =
            this.configService.get('AI_PROVIDER') === 'openai'
              ? (process.env.OPENAI_MODEL as string)
              : (process.env.GOOGLE_AI_MODEL as string);

          this.logger.verbose(`
        🤖 Answer from ${this.configService.get('AI_PROVIDER') === 'openai' ? 'GPT' : 'Gemini'} using medium-confidence context
           Question : ${question}
           Answer   : "${responseText}"
           Reason   : Scores between ${this.lowConfidenceScore} and ${this.highConfidenceScore}
      `);

          // Update interaction with medium confidence response
          this.conversationLogger.updateAnswer(interaction, responseText);
          this.conversationLogger.updateSourceQdrantMediumConfidence(
            interaction,
            mediumConfidenceDocs.map((doc) => ({
              content: doc.content,
              score: doc.score,
            })),
          );
        } else {
          // CASE 3: Check for docs with score < lowConfidenceScore
          const lowConfidenceDocs = relevantDocs.filter((doc) => doc.score < this.lowConfidenceScore);

          if (lowConfidenceDocs.length > 0) {
            // Use GPT WITHOUT context (ignore low confidence scores)
            const assistantInstructions = await this.loadAssistantPrompt(assistantType);

            const prompt = `${assistantInstructions}
                  Context: No relevant context found (low confidence scores ignored).
                  Question: ${question}
                  Provide your response in a natural, conversational way suitable for a phone conversation.`;

            const responseStartTime = Date.now();
            const response = await this.aiProvider.invoke(prompt);
            const responseTime = Date.now() - responseStartTime;

            responseText = response.content;
            modelUsed =
              this.configService.get('AI_PROVIDER') === 'openai'
                ? (process.env.OPENAI_MODEL as string)
                : (process.env.GOOGLE_AI_MODEL as string);

            this.logger.verbose(`
        🤖 Answer from ${this.configService.get('AI_PROVIDER') === 'openai' ? 'GPT' : 'Gemini'} without context
           Question : ${question}
           Answer   : "${responseText}"
           Reason   : No documents found
      `);

            // Update interaction with no context response
            this.conversationLogger.updateAnswer(interaction, responseText);
            this.conversationLogger.updateSourceQdrantLowConfidence(interaction);
          } else {
            // CASE 4: No context at all → Use GPT without context
            const assistantInstructions = await this.loadAssistantPrompt(assistantType);

            const prompt = `${assistantInstructions}
                  Context: No relevant context found.
                  Question: ${question}
                  Provide your response in a natural, conversational way suitable for a phone conversation.`;

            const responseStartTime = Date.now();
            const response = await this.aiProvider.invoke(prompt);
            const responseTime = Date.now() - responseStartTime;

            responseText = response.content;
            modelUsed =
              this.configService.get('AI_PROVIDER') === 'openai'
                ? (process.env.OPENAI_MODEL as string)
                : (process.env.GOOGLE_AI_MODEL as string);

            this.logger.verbose(`
        🤖 Answer from ${this.configService.get('AI_PROVIDER') === 'openai' ? 'GPT' : 'Gemini'} without context
           Question : ${question}
           Answer   : "${responseText}"
           Reason   : No documents found
      `);

            // Update interaction with no context response
            this.conversationLogger.updateAnswer(interaction, responseText);
            this.conversationLogger.updateSourceQdrantNoContext(interaction);
          }
        }
      }

      // Add interaction to session
      await this.conversationLogger.addInteraction(session.sessionId, interaction);

      return responseText;
    } catch (error) {
      this.logger.error('Error in Qdrant RAG process:', error);

      // Update error in interaction
      this.conversationLogger.updateError(interaction, error.message);
      throw error;
    }
  }

  // Add document with embedding to Qdrant collection
  async addToExistingCollection(collectionName: string, document: QdrantDocument): Promise<void> {
    try {
      // Log embedding details
      this.logger.log(`🔗 QDRANT - Adding document to collection: ${collectionName}`);
      this.logger.log(`🔗 QDRANT - Document ID: ${document.id}`);
      this.logger.log(`🔗 QDRANT - Embedding length: ${document.embedding.length}`);
      this.logger.log(`🔗 QDRANT - Content: ${document.content.substring(0, 100)}...`);

      // Create point for Qdrant - use numeric ID or UUID
      const pointId = this.generatePointId(document.id);
      const point: QdrantPoint = {
        id: pointId,
        vector: document.embedding,
        payload: {
          content: document.content,
          metadata: document.metadata,
        },
      };

      this.logger.log(`🔗 QDRANT - Generated point ID: ${pointId} (type: ${typeof pointId})`);
      this.logger.log(`🔗 QDRANT - Point payload metadata: ${JSON.stringify(point.payload.metadata)}`);

      // Add point to collection
      const response = await fetch(`${this.qdrantUrl}/collections/${collectionName}/points`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          points: [point],
        }),
      });

      this.logger.log(`🔗 QDRANT - Response status: ${response.status}`);
      this.logger.log(`🔗 QDRANT - Response ok: ${response.ok}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`❌ QDRANT - Failed to add document: ${response.statusText}, Response: ${errorText}`);
        throw new Error(`Failed to add document to collection: ${response.statusText}`);
      }

      const responseText = await response.text();
      this.logger.log(`🔗 QDRANT - Response body: ${responseText}`);

      this.logger.log(`✅ QDRANT - Successfully added document ${document.id} to collection ${collectionName}`);
    } catch (error) {
      this.logger.error(`❌ QDRANT - Error adding document to collection ${collectionName}:`, error);
      throw error;
    }
  }

  // Retrieve all documents and metadata from Qdrant collection using scroll API
  async getCollectionContent(collectionName: string): Promise<QdrantDocument[]> {
    try {
      this.logger.log(`Attempting to fetch content from collection: ${collectionName}`);
      this.logger.log(`Qdrant URL: ${this.qdrantUrl}`);

      const url = `${this.qdrantUrl}/collections/${collectionName}/points/scroll`;
      this.logger.log(`Full URL: ${url}`);

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            limit: 1000,
            offset: 0,
            with_vector: false,
            with_payload: true,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        this.logger.log(`Response status: ${response.status}`);
        this.logger.log(`Response ok: ${response.ok}`);
        this.logger.log(`Response status text: ${response.statusText}`);

        if (!response.ok) {
          if (response.status === 404) {
            this.logger.error(`Collection ${collectionName} does not exist (404)`);
            throw new NotFoundException(`Collection ${collectionName} does not exist`);
          }
          const errorText = await response.text();
          this.logger.error(`Failed to get collection content: ${response.statusText}, Response: ${errorText}`);
          throw new Error(`Failed to get collection content: ${response.statusText}`);
        }

        const result = await response.json();
        this.logger.log(`Response result: ${JSON.stringify(result)}`);

        const points = result.result?.points || [];
        this.logger.log(`Found ${points.length} points in collection ${collectionName}`);

        return points.map((point: any) => ({
          id: point.id,
          content: point.payload.content,
          embedding: point.vector,
          metadata: point.payload.metadata,
        }));
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          this.logger.error(`Request timed out for collection ${collectionName}`);
          throw new Error(`Request timed out for collection ${collectionName}`);
        }
        throw fetchError;
      }
    } catch (error) {
      this.logger.error(`Error getting collection content for ${collectionName}:`, error);
      throw error;
    }
  }

  // Get list of all collections with metadata and point counts
  async getCollectionList(): Promise<CollectionInfo[]> {
    try {
      const response = await fetch(`${this.qdrantUrl}/collections`);

      if (!response.ok) {
        throw new Error(`Failed to get collections: ${response.statusText}`);
      }

      const result = await response.json();
      const collections = result.result?.collections || [];

      // Fetch metadata (including points_count) for each collection
      const collectionDetails = await Promise.all(
        collections.map(async (collection: any) => {
          const infoRes = await fetch(`${this.qdrantUrl}/collections/${collection.name}`);
          if (!infoRes.ok) {
            this.logger.warn(`Failed to fetch info for collection ${collection.name}`);
            return {
              name: collection.name,
              count: 0,
              vectorSize: null,
            };
          }

          const info = await infoRes.json();
          const config = info.result?.config?.params?.vectors;
          const size = typeof config === 'object' && 'size' in config ? config.size : null;

          return {
            name: collection.name,
            count: info.result?.points_count || 0,
            vectorSize: size,
          };
        }),
      );

      return collectionDetails;
    } catch (error) {
      this.logger.error('Error getting collection list with counts:', error);
      throw error;
    }
  }

  // Convert string ID to numeric ID for Qdrant point compatibility
  private generatePointId(stringId: string): number | string {
    // For chunk IDs (containing "_chunk_"), generate a unique numeric hash
    if (stringId.includes('_chunk_')) {
      const numericHash = this.hashStringToNumber(stringId);
      this.logger.log(`🔗 QDRANT - Generated numeric hash for chunk: ${stringId} -> ${numericHash}`);
      return numericHash;
    }

    // Try to convert to number if it's numeric
    const numericId = parseInt(stringId, 10);
    if (!isNaN(numericId) && numericId >= 0) {
      this.logger.log(`🔗 QDRANT - Using numeric ID: ${numericId}`);
      return numericId;
    }

    // For other string IDs, generate a numeric hash
    const numericHash = this.hashStringToNumber(stringId);
    this.logger.log(`🔗 QDRANT - Generated numeric hash: ${stringId} -> ${numericHash}`);
    return numericHash;
  }

  // Generate a unique numeric ID from a string using a hash function
  private hashStringToNumber(str: string): number {
    // Use djb2 hash algorithm for better distribution
    let hash = 5381;

    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
    }

    // Ensure positive number
    const positiveHash = Math.abs(hash);

    // Keep it within safe integer range for JavaScript (2^53-1)
    return positiveHash % Number.MAX_SAFE_INTEGER;
  }

  // Permanently delete Qdrant collection and all its data
  async deleteCollection(collectionName: string): Promise<void> {
    try {
      const response = await fetch(`${this.qdrantUrl}/collections/${collectionName}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundException(`Collection ${collectionName} does not exist`);
        }
        throw new Error(`Failed to delete collection: ${response.statusText}`);
      }

      this.logger.log(`Deleted collection: ${collectionName}`);
    } catch (error) {
      this.logger.error(`Error deleting collection ${collectionName}:`, error);
      throw error;
    }
  }
}
