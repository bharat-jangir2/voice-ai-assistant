import OpenAI from 'openai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pipeline } from '@xenova/transformers';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly openaiClient: OpenAI;
  private sentenceTransformerEmbedder: any;
  private readonly embeddingMethod: string;

  constructor(private readonly configService: ConfigService) {
    // Determine which embedding method to use (default to sentence-transformers)
    this.embeddingMethod = this.configService.get('EMBEDDING_METHOD') || 'sentence-transformers';

    // Initialize OpenAI client
    this.openaiClient = new OpenAI({
      apiKey: this.configService.get('OPENAI_API_KEY'),
    });

    // Initialize sentence transformer if needed
    if (this.embeddingMethod === 'sentence-transformers') {
      this.initializeSentenceTransformer();
    }
    this.logger.log(`Embedding service initialized. Using: ${this.embeddingMethod} (${this.getVectorSize()}D vectors)`);
  }

  // Get vector size for current embedding method
  getVectorSize(): number {
    switch (this.embeddingMethod) {
      case 'sentence-transformers':
        return 384; // Xenova/all-MiniLM-L6-v2 dimension
      case 'openai':
        return 1536; // OpenAI text-embedding-ada-002 dimension
      default:
        return 384; // Default fallback
    }
  }

  // Get current embedding method
  getEmbeddingMethod(): string {
    return this.embeddingMethod;
  }

  // Initializes the sentence transformer model for local embedding generation
  private async initializeSentenceTransformer(): Promise<void> {
    try {
      this.sentenceTransformerEmbedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    } catch (error) {
      this.logger.error('Failed to initialize sentence transformer model:', error);
      throw new Error('Failed to initialize sentence transformer model');
    }
  }

  // Generates embeddings using OpenAI API for single text input
  async convertIntoEmbeddingsUsingOpenAI(text: string): Promise<number[]> {
    try {
      this.logger.debug(`Generating OpenAI embedding for text: "${text.substring(0, 50)}..."`);
      const startTime = Date.now();

      const response = await this.openaiClient.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text,
      });

      const embedding = response.data[0].embedding;

      const duration = Date.now() - startTime;
      this.logger.debug(`OpenAI embedding generated in ${duration}ms`);

      return embedding;
    } catch (error) {
      this.logger.error('Error generating OpenAI embedding:', error);
      throw new Error(`OpenAI embedding failed: ${error.message}`);
    }
  }

  // Generates embeddings using OpenAI API for multiple texts in batch
  async convertIntoEmbeddingsUsingOpenAIBatch(texts: string[]): Promise<number[][]> {
    try {
      this.logger.debug(`Generating OpenAI embeddings for ${texts.length} texts`);
      const startTime = Date.now();

      const response = await this.openaiClient.embeddings.create({
        model: 'text-embedding-ada-002',
        input: texts,
      });

      const embeddings = response.data.map((item) => item.embedding);

      const duration = Date.now() - startTime;
      this.logger.debug(`OpenAI batch embeddings generated in ${duration}ms`);

      return embeddings;
    } catch (error) {
      this.logger.error('Error generating OpenAI batch embeddings:', error);
      throw new Error(`OpenAI batch embedding failed: ${error.message}`);
    }
  }

  // Generates embeddings using local sentence-transformers for single text
  async convertIntoEmbeddingsUsingSentenceTransformer(text: string): Promise<number[]> {
    try {
      if (!this.sentenceTransformerEmbedder) {
        await this.initializeSentenceTransformer();
      }

      const result = await this.sentenceTransformerEmbedder(text);
      // Fix for correct 384-dim sentence embedding
      const tokenMatrix = result.data; // shape: [13, 384]
      const numTokens = result.dims[1];
      const dim = result.dims[2];

      const sentenceEmbedding: number[] = Array(dim).fill(0);

      // Sum over tokens
      for (let token = 0; token < numTokens; token++) {
        for (let i = 0; i < dim; i++) {
          sentenceEmbedding[i] += tokenMatrix[token * dim + i];
        }
      }

      // Average over tokens
      for (let i = 0; i < dim; i++) {
        sentenceEmbedding[i] /= numTokens;
      }

      return sentenceEmbedding as number[];
    } catch (error) {
      this.logger.error('Error generating sentence transformer embedding:', error);
      throw new Error(`Sentence transformer embedding failed: ${error.message}`);
    }
  }

  // Generates embeddings using local sentence-transformers for multiple texts
  async convertIntoEmbeddingsUsingSentenceTransformerBatch(texts: string[]): Promise<number[][]> {
    try {
      if (!this.sentenceTransformerEmbedder) {
        await this.initializeSentenceTransformer();
      }

      this.logger.debug(`Generating sentence transformer embeddings for ${texts.length} texts`);
      const startTime = Date.now();

      const embeddings: number[][] = [];

      // Process texts sequentially to avoid memory issues
      for (const text of texts) {
        const result = await this.sentenceTransformerEmbedder(text);

        // Fix for correct 384-dim sentence embedding
        const tokenMatrix = result.data; // shape: [13, 384]
        const numTokens = result.dims[1];
        const dim = result.dims[2];

        const sentenceEmbedding: number[] = Array(dim).fill(0);

        // Sum over tokens
        for (let token = 0; token < numTokens; token++) {
          for (let i = 0; i < dim; i++) {
            sentenceEmbedding[i] += tokenMatrix[token * dim + i];
          }
        }

        // Average over tokens
        for (let i = 0; i < dim; i++) {
          sentenceEmbedding[i] /= numTokens;
        }

        //const embedding = Array.from(result.data);
        embeddings.push(sentenceEmbedding as number[]);
      }

      const duration = Date.now() - startTime;
      this.logger.debug(`Sentence transformer batch embeddings generated in ${duration}ms`);

      return embeddings;
    } catch (error) {
      this.logger.error('Error generating sentence transformer batch embeddings:', error);
      throw new Error(`Sentence transformer batch embedding failed: ${error.message}`);
    }
  }

  // Generates embedding using the currently configured method (OpenAI or sentence-transformers)
  async generateEmbedding(text: string): Promise<number[]> {
    switch (this.embeddingMethod) {
      case 'sentence-transformers':
        return await this.convertIntoEmbeddingsUsingSentenceTransformer(text);
      case 'openai':
        return await this.convertIntoEmbeddingsUsingOpenAI(text);
      default:
        throw new Error(`Unsupported embedding method: ${this.embeddingMethod}`);
    }
  }

  // Generates embeddings for multiple texts using the currently configured method
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    switch (this.embeddingMethod) {
      case 'sentence-transformers':
        return await this.convertIntoEmbeddingsUsingSentenceTransformerBatch(texts);
      case 'openai':
        return await this.convertIntoEmbeddingsUsingOpenAIBatch(texts);
      default:
        throw new Error(`Unsupported embedding method: ${this.embeddingMethod}`);
    }
  }
}
