/**
 * Interface for Question-Answer data structure
 */
export interface QAData {
  question: string;
  answer: string;
}

/**
 * Interface for uploading content to Qdrant collection
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
 * Interface for Qdrant document structure
 */
export interface QdrantDocument {
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
  vectorSize?: number;
}

/**
 * Interface for API response structure
 */
export interface QdrantApiResponse<T = any> {
  status: 'success' | 'error';
  message?: string;
  data?: T;
  results?: any[];
  error?: string;
}

/**
 * Interface for Qdrant point structure
 */
export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload: {
    content: string;
    metadata: Record<string, any>;
  };
}

/**
 * Interface for Qdrant search result
 */
export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: {
    content: string;
    metadata: Record<string, any>;
  };
}
