import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { QdrantDBService } from './qdrant-db.services';
import { EmbeddingService } from './embedding.service';
import { QdrantDocument } from '../interfaces/qdrant.interfaces';
import { FileExtractionService } from './file-extraction.service';

export interface KnowledgeBaseFileData {
  id: string; // MongoDB _id from knowledge_bases collection
  organizationId: string;
  userId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  fileUrl: string;
  fileBuffer: Buffer;
  isActive: boolean;
}

export interface ProcessedChunk {
  chunkId: string;
  text: string;
  embedding: number[];
  metadata: {
    page?: number;
    section?: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

export interface ProcessedFile {
  id: string;
  organizationId: string;
  fileName: string;
  fileType: string;
  chunks: ProcessedChunk[];
  metadata: {
    fileSize: number;
    userId: string;
    uploadedAt: string;
    totalChunks: number;
  };
}

@Injectable()
export class KnowledgeBaseEmbeddingService {
  private readonly logger = new Logger(KnowledgeBaseEmbeddingService.name);
  private readonly CHUNK_SIZE = 1000; // Characters per chunk
  private readonly CHUNK_OVERLAP = 200; // Overlap between chunks

  constructor(
    private readonly qdrantDBService: QdrantDBService,
    private readonly embeddingService: EmbeddingService,
    private readonly fileExtractionService: FileExtractionService,
  ) {}

  /**
   * Process uploaded file and create embeddings
   */
  async processFileForEmbedding(fileData: KnowledgeBaseFileData): Promise<ProcessedFile> {
    try {
      this.logger.log(`Processing file for embedding: ${fileData.fileName} (ID: ${fileData.id})`);

      // Extract text from file based on type
      const extractedText = await this.extractTextFromFile(fileData);

      if (!extractedText || extractedText.trim().length === 0) {
        throw new BadRequestException('No text content could be extracted from the file');
      }

      // Split text into chunks
      const textChunks = this.splitTextIntoChunks(extractedText);

      this.logger.log(`Split file into ${textChunks.length} chunks`);

      // Process each chunk to create embeddings
      const processedChunks: ProcessedChunk[] = [];
      const failedChunks: number[] = [];

      this.logger.log(`🔄 Starting chunk processing for file ${fileData.fileName} - ${textChunks.length} chunks to process`);

      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];
        const chunkId = `${fileData.id}_chunk_${i + 1}`;

        this.logger.log(`📝 CHUNK ${i + 1}/${textChunks.length} - ID: ${chunkId}`);
        this.logger.log(`📝 CHUNK ${i + 1} - Length: ${chunk.length} characters`);
        this.logger.log(`📝 CHUNK ${i + 1} - Preview: "${chunk.substring(0, 100)}..."`);

        try {
          this.logger.log(`🔄 CHUNK ${i + 1} - Starting embedding generation...`);

          // Generate embedding for the chunk
          const embedding = await this.embeddingService.generateEmbedding(chunk);

          this.logger.log(`✅ CHUNK ${i + 1} - Embedding generated successfully (${embedding.length} dimensions)`);

          const processedChunk: ProcessedChunk = {
            chunkId,
            text: chunk,
            embedding,
            metadata: {
              chunkIndex: i + 1,
              totalChunks: textChunks.length,
            },
          };

          processedChunks.push(processedChunk);

          this.logger.log(`✅ CHUNK ${i + 1} - Successfully processed and added to processedChunks array`);
        } catch (error) {
          this.logger.error(`❌ CHUNK ${i + 1} - FAILED to process:`, error);
          failedChunks.push(i + 1);

          // Continue processing other chunks instead of failing the entire process
          this.logger.warn(`⚠️ CHUNK ${i + 1} - Skipping due to error, continuing with remaining chunks`);
        }
      }

      if (failedChunks.length > 0) {
        this.logger.warn(
          `Failed to process ${failedChunks.length} chunks for file ${fileData.fileName}: [${failedChunks.join(', ')}]`,
        );
      }

      if (processedChunks.length === 0) {
        throw new BadRequestException('Failed to process any chunks for the file');
      }

      const processedFile: ProcessedFile = {
        id: fileData.id,
        organizationId: fileData.organizationId,
        fileName: fileData.fileName,
        fileType: fileData.fileType,
        chunks: processedChunks,
        metadata: {
          fileSize: fileData.fileSize,
          userId: fileData.userId,
          uploadedAt: new Date().toISOString(),
          totalChunks: processedChunks.length,
        },
      };

      this.logger.log(`Successfully processed file ${fileData.fileName} into ${processedChunks.length} chunks`);
      return processedFile;
    } catch (error) {
      this.logger.error(`Failed to process file ${fileData.fileName}:`, error);
      throw error;
    }
  }

  /**
   * Store processed file embeddings in Qdrant
   */
  async storeFileEmbeddings(processedFile: ProcessedFile): Promise<void> {
    try {
      const collectionName = `org_${processedFile.organizationId}_embeddings`;

      this.logger.log(`Storing embeddings for file ${processedFile.fileName} in collection: ${collectionName}`);

      // Ensure collection exists
      await this.qdrantDBService.createCollectionIfNotExists(collectionName);

      // Store each chunk as a separate document in Qdrant
      let storedChunks = 0;
      const failedStorageChunks: string[] = [];

      this.logger.log(
        `💾 Starting storage process for file ${processedFile.fileName} - ${processedFile.chunks.length} chunks to store`,
      );

      for (const chunk of processedFile.chunks) {
        this.logger.log(`💾 STORING CHUNK ${chunk.metadata.chunkIndex}/${chunk.metadata.totalChunks} - ID: ${chunk.chunkId}`);
        this.logger.log(`💾 CHUNK ${chunk.metadata.chunkIndex} - Length: ${chunk.text.length} characters`);
        this.logger.log(`💾 CHUNK ${chunk.metadata.chunkIndex} - Preview: "${chunk.text.substring(0, 100)}..."`);

        try {
          const document: QdrantDocument = {
            id: chunk.chunkId, // Use chunk ID as the document ID
            content: chunk.text,
            embedding: chunk.embedding,
            metadata: {
              // Store MongoDB _id as the main file identifier
              fileId: processedFile.id,
              organizationId: processedFile.organizationId,
              fileName: processedFile.fileName,
              fileType: processedFile.fileType,
              fileSize: processedFile.metadata.fileSize,
              userId: processedFile.metadata.userId,
              uploadedAt: processedFile.metadata.uploadedAt,
              ...chunk.metadata,
            },
          };

          this.logger.log(`💾 CHUNK ${chunk.metadata.chunkIndex} - Calling addToExistingCollection with ID: ${document.id}`);

          await this.qdrantDBService.addToExistingCollection(collectionName, document);
          storedChunks++;

          this.logger.log(`✅ CHUNK ${chunk.metadata.chunkIndex} - Successfully stored in Qdrant`);
        } catch (error) {
          this.logger.error(`❌ CHUNK ${chunk.metadata.chunkIndex} - FAILED to store:`, error);
          failedStorageChunks.push(chunk.chunkId);

          // Continue storing other chunks instead of failing the entire process
          this.logger.warn(
            `⚠️ CHUNK ${chunk.metadata.chunkIndex} - Skipping storage due to error, continuing with remaining chunks`,
          );
        }
      }

      if (failedStorageChunks.length > 0) {
        this.logger.warn(
          `Failed to store ${failedStorageChunks.length} chunks for file ${processedFile.fileName}: [${failedStorageChunks.join(', ')}]`,
        );
      }

      this.logger.log(
        `Successfully stored ${storedChunks}/${processedFile.chunks.length} chunks for file ${processedFile.fileName}`,
      );
    } catch (error) {
      this.logger.error(`Failed to store embeddings for file ${processedFile.fileName}:`, error);
      throw error;
    }
  }

  /**
   * Complete workflow: process file and store embeddings
   */
  async processAndStoreFile(fileData: KnowledgeBaseFileData): Promise<void> {
    try {
      this.logger.log(`Starting complete processing workflow for file: ${fileData.fileName}`);

      // Step 1: Process file and create embeddings
      const processedFile = await this.processFileForEmbedding(fileData);

      // Step 2: Store embeddings in Qdrant
      await this.storeFileEmbeddings(processedFile);

      this.logger.log(`Successfully completed processing workflow for file: ${fileData.fileName}`);
    } catch (error) {
      this.logger.error(`Failed to complete processing workflow for file ${fileData.fileName}:`, error);
      throw error;
    }
  }

  /**
   * Extract text content from file using the dedicated file extraction service
   */
  private async extractTextFromFile(fileData: KnowledgeBaseFileData): Promise<string> {
    const { fileType, fileBuffer, fileName } = fileData;

    try {
      // Validate file before extraction
      this.fileExtractionService.validateFile(fileBuffer, fileName, fileType);

      // Extract text using the dedicated service
      const result = await this.fileExtractionService.extractText(fileBuffer, fileName, fileType, {
        extractMetadata: true,
        maxFileSize: 50 * 1024 * 1024, // 50MB
      });

      return result.text;
    } catch (error) {
      this.logger.error(`Failed to extract text from file ${fileName}:`, error);
      throw new BadRequestException(`Failed to extract text from file: ${error.message}`);
    }
  }

  /**
   * Split text into overlapping chunks for better embedding quality
   */
  private splitTextIntoChunks(text: string): string[] {
    if (text.length <= this.CHUNK_SIZE) {
      return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + this.CHUNK_SIZE;

      // If this isn't the last chunk, try to break at a sentence boundary
      if (end < text.length) {
        const lastSentenceEnd = text.lastIndexOf('.', end);
        const lastNewline = text.lastIndexOf('\n', end);
        const lastSpace = text.lastIndexOf(' ', end);

        // Use the best break point found
        const breakPoint = Math.max(lastSentenceEnd, lastNewline, lastSpace);
        if (breakPoint > start + this.CHUNK_SIZE * 0.5) {
          end = breakPoint + 1;
        }
      }

      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      // Move start position with overlap
      start = end - this.CHUNK_OVERLAP;
      if (start >= text.length) break;
    }

    return chunks;
  }

  /**
   * Delete file embeddings from Qdrant
   */
  async deleteFileEmbeddings(fileId: string, organizationId: string): Promise<void> {
    try {
      const collectionName = `org_${organizationId}_embeddings`;

      this.logger.log(`Deleting embeddings for file ${fileId} from collection: ${collectionName}`);

      // Note: This is a simplified implementation
      // In a production system, you might want to implement a more efficient deletion method
      // that can delete all chunks for a specific fileId without scanning the entire collection

      // For now, we'll log that deletion is needed
      this.logger.warn(`File deletion for ${fileId} in collection ${collectionName} - implementation needed`);

      // TODO: Implement efficient deletion of all chunks for a specific fileId
      // This could involve:
      // 1. Querying for all points with fileId in metadata
      // 2. Deleting those specific points
      // 3. Or implementing a batch delete operation
    } catch (error) {
      this.logger.error(`Failed to delete embeddings for file ${fileId}:`, error);
      throw error;
    }
  }

  /**
   * Search for relevant content in organization's knowledge base
   */
  async searchKnowledgeBase(
    query: string,
    organizationId: string,
    limit: number = 5,
  ): Promise<Array<{ content: string; score: number; fileId: string; fileName: string }>> {
    try {
      const collectionName = `org_${organizationId}_embeddings`;

      this.logger.log(`Searching knowledge base for query: "${query}" in collection: ${collectionName}`);

      const results = await this.qdrantDBService.findRelevantDocuments(query, collectionName);

      // Transform results to include file information
      return results.map((result) => ({
        content: result.content,
        score: result.score,
        fileId: (result as any).metadata?.fileId || 'unknown',
        fileName: (result as any).metadata?.fileName || 'unknown',
      }));
    } catch (error) {
      this.logger.error(`Failed to search knowledge base for organization ${organizationId}:`, error);
      throw error;
    }
  }

  /**
   * Debug method to check what's in the Qdrant collection
   */
  async debugCollection(organizationId: string, fileId?: string): Promise<void> {
    try {
      const collectionName = `org_${organizationId}_embeddings`;
      const qdrantUrl = (this.qdrantDBService as any).qdrantUrl || 'http://localhost:6333';
      const url = `${qdrantUrl}/collections/${collectionName}/points/scroll`;

      this.logger.log(`🔍 Debug: Checking collection ${collectionName}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 100,
          with_payload: true,
          with_vector: false,
          filter: fileId
            ? {
                must: [
                  {
                    key: 'fileId',
                    match: { value: fileId },
                  },
                ],
              }
            : undefined,
        }),
      });

      if (!response.ok) {
        this.logger.error(`Failed to debug collection: ${response.statusText}`);
        return;
      }

      const result = await response.json();
      const points = result.result?.points || [];

      this.logger.log(`🔍 Found ${points.length} points in collection`);

      points.forEach((point: any, index: number) => {
        this.logger.log(`Point ${index}:`);
        this.logger.log(`  ID: ${point.id}`);
        this.logger.log(`  File ID: ${point.payload?.metadata?.fileId}`);
        this.logger.log(`  File Name: ${point.payload?.metadata?.fileName}`);
        this.logger.log(`  Content: "${point.payload?.content?.substring(0, 100)}..."`);
      });
    } catch (error) {
      this.logger.error(`Failed to debug collection: ${error.message}`);
    }
  }
}
