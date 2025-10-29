/**
 * Interface for Question-Answer data structure
 */
export interface QAData {
  question: string;
  answer: string;
}

/**
 * Interface for uploading content to ChromaDB collection
 */
export interface UploadContentDto {
  collectionName: string;
  data: QAData[];
}

/**
 * Interface for getting collection content
 */
export interface GetCollectionDto {
  collectionName: string;
}

/**
 * Interface for ChromaDB document structure
 */
export interface ChromaDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
}

/**
 * Interface for collection information
 */
export interface CollectionInfo {
  name: string;
  count: number;
}

/**
 * Interface for API response structure
 */
export interface ChromaApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
  results?: any[];
  error?: string;
}
