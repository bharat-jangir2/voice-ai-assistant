import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChromaClient, Collection } from 'chromadb';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ConversationLoggerService, ConversationInteraction } from './conversation-logger.service';
import { EmbeddingService } from './embedding.service';
import { ChromaDocument, CollectionInfo } from '../interfaces/chroma.interfaces';

@Injectable()
export class ChromaDBService {
  private readonly logger = new Logger(ChromaDBService.name);
  private readonly chromaClient: ChromaClient;
  private readonly model: OpenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly conversationLogger: ConversationLoggerService,
    private readonly embeddingService: EmbeddingService,
  ) {
    // Initialize ChromaDB client with modern configuration
    const chromaUrl = this.configService.get('CHROMA_DB_URL') || 'http://localhost:8000';

    // Parse the URL to extract host and port
    const url = new URL(chromaUrl);
    this.chromaClient = new ChromaClient({
      host: url.hostname,
      port: parseInt(url.port) || 8000,
      ssl: url.protocol === 'https:',
    });

    // Initialize OpenAI model
    this.model = new OpenAI({
      apiKey: this.configService.get('OPENAI_API_KEY'),
    });
  }

  // Gets or creates a collection for a specific assistant type
  private async getCollectionForAssistant(assistantType: string): Promise<Collection> {
    try {
      return await this.chromaClient.getOrCreateCollection({
        name: assistantType,
        embeddingFunction: {
          generate: async (texts: string[]) => {
            const embeddings = await this.embeddingService.generateEmbeddings(texts);
            return embeddings;
          },
        },
      });
    } catch (error) {
      this.logger.error(`Failed to get collection for assistant type ${assistantType}:`, error);
      throw error;
    }
  }

  // Finds relevant documents from the specified assistant's collection using semantic search
  async findRelevantDocuments(query: string, assistantType: string = 'general'): Promise<string[]> {
    try {
      // Get the collection for the specific assistant type
      const collection = await this.getCollectionForAssistant(assistantType);

      // Generate embedding for the query
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);

      // Search for similar documents
      const results: any = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: 3, // Get top 3 most relevant documents
      });

      return results.documents[0] || [];
    } catch (error) {
      // Handle embedding dimension mismatch and other ChromaDB errors gracefully
      if (error.message && error.message.includes('Collection expecting embedding with dimension')) {
        this.logger.warn('Embedding dimension mismatch detected. Context not found in database.');
        return []; // Return empty array instead of throwing error
      }

      // Handle other ChromaDB errors gracefully
      if (error.message && error.message.includes('ChromaClientError')) {
        this.logger.warn('ChromaDB connection issue. Context not found in database.');
        return []; // Return empty array instead of throwing error
      }

      // For other unexpected errors, still log but return empty array
      this.logger.warn('Unexpected error while searching database. Context not found.');
      this.logger.debug('Error details:', error.message);
      return [];
    }
  }

  // Loads the prompt instructions for a specific assistant type from JSON file
  private async loadAssistantPrompt(assistantType: string): Promise<string> {
    try {
      // Fix path resolution to look in source directory instead of dist
      // Go up from dist/twilio/services to src/twilio/assistant
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

  // Generates an answer using ChromaDB RAG with dynamic prompt based on assistant type
  async getAnswerUsingChromaRAG(
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

      this.logger.verbose(`
        ✅ ${relevantDocs.length} Context Documents fetched from ChromaDB
           Time taken: ${searchTime}ms
           Documents: ${JSON.stringify(relevantDocs, null, 2)}
      `);

      let responseText: string;
      let modelUsed: string;

      // Check if we have relevant documents from ChromaDB
      if (relevantDocs && relevantDocs.length > 0) {
        // Use ChromaDB response
        const firstDoc = relevantDocs[0];

        // Extract answer from the format "Question: ...\nAnswer: ..."
        const answerMatch = firstDoc.match(/Answer:\s*(.+)/);
        if (answerMatch && answerMatch[1]) {
          responseText = answerMatch[1].trim();
        } else {
          responseText = "I found some information but couldn't extract a specific answer.";
        }

        this.logger.verbose(`
        ✅ Answer from ChromaDB
           Question : ${question}
           Answer   : "${responseText}"
        `);

        modelUsed = 'chroma-db-direct';

        // Update interaction with ChromaDB response
        this.conversationLogger.updateAnswer(interaction, responseText);
        this.conversationLogger.updateSourceQdrantHighConfidence(
          interaction,
          relevantDocs.map((doc) => ({
            content: doc,
            score: 1.0, // ChromaDB doesn't provide scores, so we'll use 1.0 for direct matches
          })),
        );
      } else {
        // Fallback to OpenAI when no context found
        this.logger.log('No relevant context found in database, using OpenAI fallback');

        // Load the dynamic prompt based on assistant type
        const assistantInstructions = await this.loadAssistantPrompt(assistantType);

        // Create the complete prompt with fallback message
        const prompt = `${assistantInstructions}

        Context: No relevant context found in knowledge base.

        Question: ${question}

        Please provide your response in a natural, conversational way that would sound good in a phone conversation. 
        If you don't have enough information to answer the question accurately, please acknowledge this and provide a helpful response based on your general knowledge.`;

        // Generate AI response with timing
        const responseStartTime = Date.now();
        const response = await this.model.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are a helpful AI assistant.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
        });
        const responseTime = Date.now() - responseStartTime;

        responseText =
          typeof response.choices[0]?.message?.content === 'string'
            ? 'Context not found in vector database. ' + response.choices[0].message.content
            : 'Context not found in vector database. ' + JSON.stringify(response.choices[0]?.message?.content);
        modelUsed = process.env.OPENAI_MODEL as string;

        this.logger.verbose(`
          🔊 Answer from OpenAI (Fallback)
            • Question : ${question}
            • Answer   : "${responseText}"
            • Reason   : No relevant context found in database
        `);

        // Update interaction with no context response
        this.conversationLogger.updateAnswer(interaction, responseText);
        this.conversationLogger.updateSourceNoContext(interaction);
      }

      // Add interaction to session
      await this.conversationLogger.addInteraction(session.sessionId, interaction);

      return responseText;
    } catch (error) {
      this.logger.error('Error in ChromaDB RAG process:', error);

      // Update error in interaction
      this.conversationLogger.updateError(interaction, error.message);
      throw error;
    }
  }

  // Adds a document to the specified ChromaDB collection with embeddings and metadata
  async addToCollection(collectionName: string, document: ChromaDocument) {
    try {
      // Get or create collection
      const collection = await this.chromaClient.getOrCreateCollection({
        name: collectionName ?? 'default',
        embeddingFunction: {
          generate: async (texts: string[]) => {
            const embeddings = await this.embeddingService.generateEmbeddings(texts);
            return embeddings;
          },
        },
      });

      // Add document to collection
      await collection.add({
        ids: [document.id],
        embeddings: [document.embedding],
        documents: [document.content],
        metadatas: [document.metadata],
      });

      this.logger.log(`Successfully added document ${document.id} to collection ${collectionName}`);
    } catch (error) {
      this.logger.error(`Error adding document to collection ${collectionName}:`, error);
      throw error;
    }
  }

  // Retrieves all content from a specified ChromaDB collection
  async getCollectionContent(collectionName: string) {
    try {
      // Get collection
      const collection = await this.chromaClient.getCollection({
        name: collectionName,
      });

      // Get all documents from collection
      const result = await collection.get();

      // Format the response
      const formattedContent = result.ids.map((id, index) => ({
        id: id,
        content: result.documents[index],
        metadata: result.metadatas[index],
        // If you want to include embeddings, uncomment the next line
        // embedding: result.embeddings[index],
      }));

      return formattedContent;
    } catch (error) {
      if (error.message === 'The requested resource could not be found') {
        throw new NotFoundException(`Collection '${collectionName}' does not exist`);
      }
      this.logger.error(`Error getting collection content: ${error.message}`);
      throw error;
    }
  }

  // Lists all ChromaDB collections with their document counts
  async getCollectionList(): Promise<CollectionInfo[]> {
    try {
      // Get all collections
      const collections = await this.chromaClient.listCollections();

      // Get count for each collection
      const collectionsWithCount = await Promise.all(
        collections.map(async (collection) => {
          try {
            // Get the collection to access its count
            const col = await this.chromaClient.getCollection({
              name: collection.name,
            });
            const result = await col.count();

            return {
              name: collection.name,
              count: result,
            };
          } catch (error) {
            this.logger.warn(`Could not get count for collection ${collection.name}:`, error);
            return {
              name: collection.name,
              count: 0,
            };
          }
        }),
      );

      return collectionsWithCount;
    } catch (error) {
      this.logger.error('Error getting collection list:', error);
      throw error;
    }
  }

  // Deletes a ChromaDB collection by name
  async deleteCollection(collectionName: string): Promise<void> {
    try {
      // Check if collection exists first
      const collections = await this.chromaClient.listCollections();
      const collectionExists = collections.some((col) => col.name === collectionName);

      if (!collectionExists) {
        throw new Error(`Collection '${collectionName}' does not exist`);
      }

      // Delete the collection
      await this.chromaClient.deleteCollection({
        name: collectionName,
      });

      this.logger.log(`Successfully deleted collection: ${collectionName}`);
    } catch (error) {
      this.logger.error(`Error deleting collection ${collectionName}:`, error);
      throw error;
    }
  }
}
