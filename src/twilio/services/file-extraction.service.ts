import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface FileExtractionResult {
  text: string;
  metadata?: {
    pages?: number;
    author?: string;
    title?: string;
    creationDate?: string;
    modificationDate?: string;
    [key: string]: any;
  };
}

export interface FileExtractionOptions {
  maxFileSize?: number; // in bytes
  extractImages?: boolean;
  extractMetadata?: boolean;
}

@Injectable()
export class FileExtractionService {
  private readonly logger = new Logger(FileExtractionService.name);
  private readonly MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB default

  /**
   * Extract text content from various file types
   */
  async extractText(
    fileBuffer: Buffer,
    fileName: string,
    fileType: string,
    options: FileExtractionOptions = {},
  ): Promise<FileExtractionResult> {
    const { maxFileSize = this.MAX_FILE_SIZE, extractMetadata = true } = options;

    // Validate file size
    if (fileBuffer.length > maxFileSize) {
      throw new BadRequestException(`File size ${fileBuffer.length} bytes exceeds maximum allowed size ${maxFileSize} bytes`);
    }

    this.logger.log(`Extracting text from ${fileType} file: ${fileName}`);

    try {
      switch (fileType.toLowerCase()) {
        case 'pdf':
          return await this.extractFromPDF(fileBuffer, fileName, extractMetadata);

        case 'docx':
        case 'doc':
          return await this.extractFromDOCX(fileBuffer, fileName, extractMetadata);

        case 'xlsx':
        case 'xls':
          return await this.extractFromXLSX(fileBuffer, fileName, extractMetadata);

        case 'txt':
        case 'log':
        case 'md':
        case 'html':
        case 'csv':
        case 'json':
        case 'xml':
        case 'yaml':
        case 'yml':
          return await this.extractFromText(fileBuffer, fileName);

        case 'rtf':
          return await this.extractFromRTF(fileBuffer, fileName);

        default:
          this.logger.warn(`Unsupported file type: ${fileType} for file: ${fileName}`);
          throw new BadRequestException(`Unsupported file type: ${fileType}`);
      }
    } catch (error) {
      this.logger.error(`Failed to extract text from file ${fileName}:`, error);
      throw new BadRequestException(`Failed to extract text from file: ${error.message}`);
    }
  }

  /**
   * Extract text from PDF files using pdf-parse
   * Reference: https://github.com/modesty/pdf-parse
   */
  private async extractFromPDF(fileBuffer: Buffer, fileName: string, extractMetadata: boolean): Promise<FileExtractionResult> {
    try {
      this.logger.log(`Extracting text from PDF: ${fileName} (${fileBuffer.length} bytes)`);

      // Try to import pdf-parse with error handling
      let pdfParse;
      try {
        pdfParse = require('pdf-parse');
        this.logger.log(`PDF parsing library loaded successfully`);
      } catch (importError) {
        this.logger.warn(`PDF parsing library not available: ${importError.message}`);
        return {
          text: `PDF file: ${fileName} (PDF parsing library not available - please install pdf-parse)\n\nThis is a fallback message to ensure the file is processed. The actual PDF content could not be extracted due to library issues. Please check the logs for more details.`,
          metadata: extractMetadata ? { pages: 0, error: 'PDF parsing library not available' } : undefined,
        };
      }

      // Try different ways to call pdf-parse
      let data;
      try {
        // Method 1: Direct call
        this.logger.log(`Attempting PDF parsing with direct call...`);
        data = await pdfParse(fileBuffer);
        this.logger.log(`PDF parsing successful with direct call`);
      } catch (firstError) {
        this.logger.warn(`Direct call failed: ${firstError.message}`);
        try {
          // Method 2: Default export
          this.logger.log(`Attempting PDF parsing with default export...`);
          data = await pdfParse.default(fileBuffer);
          this.logger.log(`PDF parsing successful with default export`);
        } catch (secondError) {
          this.logger.warn(`Default export failed: ${secondError.message}`);
          try {
            // Method 3: Check if it's a constructor
            this.logger.log(`Attempting PDF parsing with constructor...`);
            const parser = new pdfParse();
            data = await parser(fileBuffer);
            this.logger.log(`PDF parsing successful with constructor`);
          } catch (thirdError) {
            this.logger.error(`PDF parsing failed with all methods: ${firstError.message}`);
            return {
              text: `PDF file: ${fileName} (PDF parsing failed - ${firstError.message})\n\nThis is a fallback message to ensure the file is processed. The actual PDF content could not be extracted due to parsing errors. Please check the logs for more details.\n\nFile size: ${fileBuffer.length} bytes\nError: ${firstError.message}`,
              metadata: extractMetadata ? { pages: 0, error: firstError.message } : undefined,
            };
          }
        }
      }

      if (!data.text || data.text.trim().length === 0) {
        this.logger.warn(`PDF file ${fileName} appears to be empty or contains no extractable text`);
        return {
          text: `PDF file: ${fileName} (no text content found)\n\nThis is a fallback message to ensure the file is processed. The PDF file appears to be empty or contains no extractable text.`,
          metadata: extractMetadata ? { pages: data.numpages || 0 } : undefined,
        };
      }

      this.logger.log(`Successfully extracted ${data.text.length} characters from PDF: ${fileName}`);

      const result: FileExtractionResult = {
        text: data.text,
      };

      if (extractMetadata) {
        result.metadata = {
          pages: data.numpages || 0,
          info: data.info || {},
        };
      }

      return result;
    } catch (error) {
      this.logger.error(`Failed to extract text from PDF ${fileName}:`, error);
      return {
        text: `PDF file: ${fileName} (extraction failed - ${error.message})\n\nThis is a fallback message to ensure the file is processed. The actual PDF content could not be extracted due to an unexpected error. Please check the logs for more details.\n\nFile size: ${fileBuffer.length} bytes\nError: ${error.message}`,
        metadata: extractMetadata ? { pages: 0, error: error.message } : undefined,
      };
    }
  }

  /**
   * Extract text from DOCX files using mammoth
   * Reference: https://github.com/mwilliamson/mammoth.js
   */
  private async extractFromDOCX(fileBuffer: Buffer, fileName: string, extractMetadata: boolean): Promise<FileExtractionResult> {
    try {
      const mammoth = require('mammoth');

      this.logger.log(`Extracting text from DOCX: ${fileName}`);

      const result = await mammoth.extractRawText({ buffer: fileBuffer });

      if (!result.value || result.value.trim().length === 0) {
        this.logger.warn(`DOCX file ${fileName} appears to be empty or contains no extractable text`);
        return {
          text: `DOCX file: ${fileName} (no text content found)`,
        };
      }

      this.logger.log(`Successfully extracted ${result.value.length} characters from DOCX: ${fileName}`);

      const extractionResult: FileExtractionResult = {
        text: result.value,
      };

      if (extractMetadata && result.messages) {
        extractionResult.metadata = {
          warnings: result.messages.filter((m) => m.type === 'warning').map((m) => m.message),
        };
      }

      return extractionResult;
    } catch (error) {
      this.logger.error(`Failed to extract text from DOCX ${fileName}:`, error);
      throw new BadRequestException(`Failed to extract text from DOCX: ${error.message}`);
    }
  }

  /**
   * Extract text from XLSX files using xlsx
   * Reference: https://github.com/SheetJS/sheetjs
   */
  private async extractFromXLSX(fileBuffer: Buffer, fileName: string, extractMetadata: boolean): Promise<FileExtractionResult> {
    try {
      const XLSX = require('xlsx');

      this.logger.log(`Extracting text from XLSX: ${fileName}`);

      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        this.logger.warn(`XLSX file ${fileName} appears to be empty or contains no sheets`);
        return {
          text: `XLSX file: ${fileName} (no sheets found)`,
        };
      }

      let extractedText = '';
      const sheetData: any[] = [];

      // Extract text from all sheets
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const sheetText = XLSX.utils.sheet_to_txt(sheet);

        if (sheetText.trim()) {
          extractedText += `\n--- Sheet: ${sheetName} ---\n${sheetText}\n`;

          // Also extract as JSON for structured data
          const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          sheetData.push({
            sheetName,
            data: jsonData,
          });
        }
      }

      if (!extractedText.trim()) {
        this.logger.warn(`XLSX file ${fileName} contains no extractable text`);
        return {
          text: `XLSX file: ${fileName} (no text content found)`,
        };
      }

      this.logger.log(`Successfully extracted text from XLSX: ${fileName}`);

      const result: FileExtractionResult = {
        text: extractedText.trim(),
      };

      if (extractMetadata) {
        result.metadata = {
          sheets: workbook.SheetNames,
          sheetCount: workbook.SheetNames.length,
          sheetData,
        };
      }

      return result;
    } catch (error) {
      this.logger.error(`Failed to extract text from XLSX ${fileName}:`, error);
      throw new BadRequestException(`Failed to extract text from XLSX: ${error.message}`);
    }
  }

  /**
   * Extract text from plain text files
   */
  private async extractFromText(fileBuffer: Buffer, fileName: string): Promise<FileExtractionResult> {
    try {
      this.logger.log(`Extracting text from text file: ${fileName}`);

      const text = fileBuffer.toString('utf-8');

      if (!text.trim()) {
        this.logger.warn(`Text file ${fileName} appears to be empty`);
        return {
          text: `Text file: ${fileName} (empty)`,
        };
      }

      this.logger.log(`Successfully extracted ${text.length} characters from text file: ${fileName}`);

      return {
        text,
      };
    } catch (error) {
      this.logger.error(`Failed to extract text from text file ${fileName}:`, error);
      throw new BadRequestException(`Failed to extract text from text file: ${error.message}`);
    }
  }

  /**
   * Extract text from RTF files using officeparser
   * Reference: https://www.npmjs.com/package/officeparser
   */
  private async extractFromRTF(fileBuffer: Buffer, fileName: string): Promise<FileExtractionResult> {
    try {
      const officeParser = require('officeparser');

      this.logger.log(`Extracting text from RTF: ${fileName}`);

      return new Promise((resolve, reject) => {
        officeParser.parseRtf(fileBuffer, (err: any, data: any) => {
          if (err) {
            this.logger.error(`Failed to extract text from RTF ${fileName}:`, err);
            reject(new BadRequestException(`Failed to extract text from RTF: ${err.message}`));
            return;
          }

          if (!data || !data.text || data.text.trim().length === 0) {
            this.logger.warn(`RTF file ${fileName} appears to be empty or contains no extractable text`);
            resolve({
              text: `RTF file: ${fileName} (no text content found)`,
            });
            return;
          }

          this.logger.log(`Successfully extracted ${data.text.length} characters from RTF: ${fileName}`);

          resolve({
            text: data.text,
            metadata: data.metadata || {},
          });
        });
      });
    } catch (error) {
      this.logger.error(`Failed to extract text from RTF ${fileName}:`, error);
      throw new BadRequestException(`Failed to extract text from RTF: ${error.message}`);
    }
  }

  /**
   * Get supported file types
   */
  getSupportedFileTypes(): string[] {
    return ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'txt', 'log', 'md', 'html', 'csv', 'json', 'xml', 'yaml', 'yml', 'rtf'];
  }

  /**
   * Check if file type is supported
   */
  isFileTypeSupported(fileType: string): boolean {
    return this.getSupportedFileTypes().includes(fileType.toLowerCase());
  }

  /**
   * Get file type from filename
   */
  getFileTypeFromFileName(fileName: string): string {
    const extension = fileName.split('.').pop()?.toLowerCase();
    return extension || '';
  }

  /**
   * Validate file before extraction
   */
  validateFile(fileBuffer: Buffer, fileName: string, fileType: string): void {
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('File buffer is empty');
    }

    if (!fileName || fileName.trim().length === 0) {
      throw new BadRequestException('File name is required');
    }

    if (!fileType || fileType.trim().length === 0) {
      throw new BadRequestException('File type is required');
    }

    if (!this.isFileTypeSupported(fileType)) {
      throw new BadRequestException(`Unsupported file type: ${fileType}`);
    }

    if (fileBuffer.length > this.MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File size ${fileBuffer.length} bytes exceeds maximum allowed size ${this.MAX_FILE_SIZE} bytes`,
      );
    }
  }
}
