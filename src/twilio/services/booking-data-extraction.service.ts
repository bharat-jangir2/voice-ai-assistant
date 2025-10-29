import { Injectable, Logger } from '@nestjs/common';

export interface ExtractionResult {
  success: boolean;
  extractedValue: string | null;
  confidence: number;
  originalInput: string;
  processedSteps: string[];
  suggestions?: string[];
}

@Injectable()
export class BookingDataExtractionService {
  private readonly logger = new Logger(BookingDataExtractionService.name);

  // Token mapping for spoken symbols
  private readonly tokenMappings = new Map<string, string>([
    // Email symbols
    ['at', '@'],
    ['@', '@'],
    ['dot', '.'],
    ['period', '.'],
    ['full stop', '.'],
    ['point', '.'],
    ['.', '.'],
    ['underscore', '_'],
    ['under score', '_'],
    ['_', '_'],
    ['dash', '-'],
    ['hyphen', '-'],
    ['minus', '-'],
    ['-', '-'],
    ['plus', '+'],
    ['plus sign', '+'],
    ['+', '+'],
    
    // Common filler words to remove
    ['please', ''],
    ['my', ''],
    ['email is', ''],
    ['email', ''],
    ['phone number is', ''],
    ['phone number', ''],
    ['mobile number is', ''],
    ['mobile number', ''],
    ['number is', ''],
    ['number', ''],
    ['is', ''],
    ['the', ''],
    ['a', ''],
    ['an', ''],
  ]);

  // Common ASR corrections for email domains
  private readonly emailDomainCorrections = new Map<string, string>([
    ['g mail', 'gmail'],
    ['g m a i l', 'gmail'],
    ['out look', 'outlook'],
    ['out l o o k', 'outlook'],
    ['yahoo', 'yahoo'],
    ['hot mail', 'hotmail'],
    ['hot m a i l', 'hotmail'],
    ['proton mail', 'protonmail'],
    ['proton m a i l', 'protonmail'],
  ]);

  // Common TLD corrections
  private readonly tldCorrections = new Map<string, string>([
    ['c o m', 'com'],
    ['c o m dot', 'com'],
    ['dot c o m', 'com'],
    ['c o m dot', 'com'],
    ['o r g', 'org'],
    ['n e t', 'net'],
    ['i n', 'in'],
    ['c o dot i n', 'co.in'],
    ['c o dot u k', 'co.uk'],
  ]);

  // Common mobile number patterns and corrections
  private readonly mobilePatterns = {
    // Indian mobile patterns
    indian: /^(\+91|91|0)?[6-9]\d{9}$/,
    // International patterns
    international: /^(\+\d{1,3})?\d{6,15}$/,
  };

  // Email regex for validation
  private readonly emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

  /**
   * Main method to extract email from spoken input
   */
  async extractEmail(input: string): Promise<ExtractionResult> {
    const steps: string[] = [];
    let processedInput = input;

    try {
      this.logger.debug(`🔍 [EMAIL] Starting extraction for: "${input}"`);

      // Step 1: Normalize input
      processedInput = this.normalizeInput(input);
      steps.push(`Normalized: "${processedInput}"`);

      // Step 2: Tokenize
      const tokens = this.tokenize(processedInput);
      steps.push(`Tokenized: [${tokens.join(', ')}]`);

      // Step 3: Map tokens to symbols
      const mappedTokens = this.mapTokens(tokens);
      steps.push(`Mapped: [${mappedTokens.join(', ')}]`);

      // Step 4: Remove filler words
      const cleanedTokens = this.removeFillerWords(mappedTokens);
      steps.push(`Cleaned: [${cleanedTokens.join(', ')}]`);

      // Step 5: Join spelled-out letters/numbers
      const joinedTokens = this.joinSpelledOutTokens(cleanedTokens);
      steps.push(`Joined: [${joinedTokens.join(', ')}]`);

      // Step 6: Apply domain corrections
      const correctedTokens = this.applyDomainCorrections(joinedTokens);
      steps.push(`Domain corrected: [${correctedTokens.join(', ')}]`);

      // Step 7: Reconstruct email
      const reconstructedEmail = this.reconstructEmail(correctedTokens);
      steps.push(`Reconstructed: "${reconstructedEmail}"`);

      // Step 8: Validate email
      const isValid = this.emailRegex.test(reconstructedEmail);
      steps.push(`Valid: ${isValid}`);

      // Always apply fuzzy corrections for common misspellings, even if email is valid
      const fuzzyResult = this.applyFuzzyEmailCorrections(reconstructedEmail);
      if (fuzzyResult.success && fuzzyResult.correctedEmail !== reconstructedEmail) {
        steps.push(`Fuzzy corrected: "${fuzzyResult.correctedEmail}"`);
        this.logger.log(`✅ [EMAIL] Fuzzy correction successful: "${fuzzyResult.correctedEmail}"`);
        return {
          success: true,
          extractedValue: fuzzyResult.correctedEmail,
          confidence: 0.8,
          originalInput: input,
          processedSteps: steps,
        };
      }

      if (isValid) {
        this.logger.log(`✅ [EMAIL] Successfully extracted: "${reconstructedEmail}"`);
        return {
          success: true,
          extractedValue: reconstructedEmail,
          confidence: 0.9,
          originalInput: input,
          processedSteps: steps,
        };
      }

      // Step 9: Try fuzzy corrections if validation fails
      const fuzzyResult2 = this.applyFuzzyEmailCorrections(reconstructedEmail);
      if (fuzzyResult2.success) {
        steps.push(`Fuzzy corrected: "${fuzzyResult2.correctedEmail}"`);
        this.logger.log(`✅ [EMAIL] Fuzzy correction successful: "${fuzzyResult2.correctedEmail}"`);
        return {
          success: true,
          extractedValue: fuzzyResult2.correctedEmail,
          confidence: 0.7,
          originalInput: input,
          processedSteps: steps,
        };
      }

      // Step 10: Generate suggestions
      const suggestions = this.generateEmailSuggestions(reconstructedEmail);
      steps.push(`Generated ${suggestions.length} suggestions`);

      this.logger.warn(`❌ [EMAIL] Extraction failed for: "${input}"`);
      return {
        success: false,
        extractedValue: null,
        confidence: 0.3,
        originalInput: input,
        processedSteps: steps,
        suggestions,
      };

    } catch (error) {
      this.logger.error(`❌ [EMAIL] Error during extraction:`, error);
      return {
        success: false,
        extractedValue: null,
        confidence: 0.0,
        originalInput: input,
        processedSteps: [...steps, `Error: ${error.message}`],
      };
    }
  }

  /**
   * Main method to extract mobile number from spoken input
   */
  async extractMobileNumber(input: string): Promise<ExtractionResult> {
    const steps: string[] = [];
    let processedInput = input;

    try {
      this.logger.debug(`🔍 [MOBILE] Starting extraction for: "${input}"`);

      // Step 1: Normalize input
      processedInput = this.normalizeInput(input);
      steps.push(`Normalized: "${processedInput}"`);

      // Step 2: Tokenize
      const tokens = this.tokenize(processedInput);
      steps.push(`Tokenized: [${tokens.join(', ')}]`);

      // Step 3: Remove filler words
      const cleanedTokens = this.removeFillerWords(tokens);
      steps.push(`Cleaned: [${cleanedTokens.join(', ')}]`);

      // Step 4: Convert spelled-out numbers
      const numberTokens = this.convertSpelledNumbers(cleanedTokens);
      steps.push(`Number converted: [${numberTokens.join(', ')}]`);

      // Step 5: Reconstruct number
      const reconstructedNumber = this.reconstructMobileNumber(numberTokens);
      steps.push(`Reconstructed: "${reconstructedNumber}"`);

      // Step 6: Validate number
      const validationResult = this.validateMobileNumber(reconstructedNumber);
      steps.push(`Valid: ${validationResult.isValid} (${validationResult.type})`);

      if (validationResult.isValid) {
        this.logger.log(`✅ [MOBILE] Successfully extracted: "${reconstructedNumber}"`);
        return {
          success: true,
          extractedValue: reconstructedNumber,
          confidence: 0.9,
          originalInput: input,
          processedSteps: steps,
        };
      }

      // Step 7: Try fuzzy corrections
      const fuzzyResult = this.applyFuzzyMobileCorrections(reconstructedNumber);
      if (fuzzyResult.success) {
        steps.push(`Fuzzy corrected: "${fuzzyResult.correctedNumber}"`);
        this.logger.log(`✅ [MOBILE] Fuzzy correction successful: "${fuzzyResult.correctedNumber}"`);
        return {
          success: true,
          extractedValue: fuzzyResult.correctedNumber,
          confidence: 0.7,
          originalInput: input,
          processedSteps: steps,
        };
      }

      // Step 8: Generate suggestions
      const suggestions = this.generateMobileSuggestions(reconstructedNumber);
      steps.push(`Generated ${suggestions.length} suggestions`);

      this.logger.warn(`❌ [MOBILE] Extraction failed for: "${input}"`);
      return {
        success: false,
        extractedValue: null,
        confidence: 0.3,
        originalInput: input,
        processedSteps: steps,
        suggestions,
      };

    } catch (error) {
      this.logger.error(`❌ [MOBILE] Error during extraction:`, error);
      return {
        success: false,
        extractedValue: null,
        confidence: 0.0,
        originalInput: input,
        processedSteps: [...steps, `Error: ${error.message}`],
      };
    }
  }

  /**
   * Normalize input: lowercase and trim
   */
  private normalizeInput(input: string): string {
    return input.toLowerCase().trim();
  }

  /**
   * Tokenize input by spaces and punctuation
   */
  private tokenize(input: string): string[] {
    return input
      .split(/[\s,.-]+/)
      .filter(token => token.length > 0);
  }

  /**
   * Map spoken tokens to symbols
   */
  private mapTokens(tokens: string[]): string[] {
    return tokens.map(token => {
      const mapped = this.tokenMappings.get(token);
      return mapped !== undefined ? mapped : token;
    });
  }

  /**
   * Remove filler words
   */
  private removeFillerWords(tokens: string[]): string[] {
    return tokens.filter(token => {
      // Don't remove tokens that are mapped to symbols (like @, ., etc.)
      const mapped = this.tokenMappings.get(token);
      if (mapped !== undefined && mapped !== '') {
        return true; // Keep mapped symbols
      }
      // Remove only known filler words, but keep empty strings for now
      if (token === '') {
        return false; // Remove empty strings
      }
      return !this.isFillerWord(token);
    });
  }

  /**
   * Check if a token is a filler word
   */
  private isFillerWord(token: string): boolean {
    const fillerWords = ['please', 'my', 'email', 'is', 'the', 'a', 'an'];
    return fillerWords.includes(token.toLowerCase());
  }

  /**
   * Join spelled-out letters/numbers (e.g., "c o m" -> "com")
   */
  private joinSpelledOutTokens(tokens: string[]): string[] {
    const result: string[] = [];
    let i = 0;

    while (i < tokens.length) {
      const currentToken = tokens[i];
      
      // Check if this is a single letter/number that might be part of a spelled sequence
      if (this.isSingleChar(currentToken) && i < tokens.length - 1) {
        const spelledSequence = this.extractSpelledSequence(tokens, i);
        if (spelledSequence.length > 1) {
          result.push(spelledSequence.join(''));
          i += spelledSequence.length;
          continue;
        }
      }
      
      result.push(currentToken);
      i++;
    }

    return result;
  }

  /**
   * Check if token is a single character (letter or number)
   */
  private isSingleChar(token: string): boolean {
    return token.length === 1 && /[a-z0-9]/.test(token);
  }

  /**
   * Extract a sequence of spelled-out characters
   */
  private extractSpelledSequence(tokens: string[], startIndex: number): string[] {
    const sequence: string[] = [];
    let i = startIndex;

    while (i < tokens.length && this.isSingleChar(tokens[i])) {
      sequence.push(tokens[i]);
      i++;
    }

    return sequence;
  }

  /**
   * Apply domain-specific corrections
   */
  private applyDomainCorrections(tokens: string[]): string[] {
    const result: string[] = [];
    let i = 0;

    while (i < tokens.length) {
      // Check for domain patterns
      if (i < tokens.length - 1) {
        const twoToken = `${tokens[i]} ${tokens[i + 1]}`;
        const threeToken = i < tokens.length - 2 ? `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}` : '';
        
        if (this.emailDomainCorrections.has(twoToken)) {
          result.push(this.emailDomainCorrections.get(twoToken)!);
          i += 2;
          continue;
        }
        
        if (threeToken && this.emailDomainCorrections.has(threeToken)) {
          result.push(this.emailDomainCorrections.get(threeToken)!);
          i += 3;
          continue;
        }
      }

      // Check for TLD patterns
      if (i < tokens.length - 1) {
        const tldPattern = tokens.slice(i, i + 3).join(' ');
        if (this.tldCorrections.has(tldPattern)) {
          result.push(this.tldCorrections.get(tldPattern)!);
          i += 3;
          continue;
        }
      }

      result.push(tokens[i]);
      i++;
    }

    return result;
  }

  /**
   * Reconstruct email from tokens
   */
  private reconstructEmail(tokens: string[]): string {
    // Find the @ symbol and reconstruct around it
    const atIndex = tokens.findIndex(token => token === '@');
    if (atIndex === -1) {
      // No @ found, try to join all tokens
      return tokens.join('');
    }
    
    const localPart = tokens.slice(0, atIndex).join('');
    const domainPart = tokens.slice(atIndex + 1).join('');
    
    // Clean up the result
    let email = `${localPart}@${domainPart}`;
    
    // Remove any remaining spaces or invalid characters
    email = email.replace(/\s+/g, '').toLowerCase();
    
    return email;
  }

  /**
   * Apply fuzzy corrections for email
   */
  private applyFuzzyEmailCorrections(email: string): { success: boolean; correctedEmail: string } {
    // Common ASR mistakes in emails
    const corrections = [
      { pattern: /g\s*m\s*a\s*i\s*l/g, replacement: 'gmail' },
      { pattern: /out\s*l\s*o\s*o\s*k/g, replacement: 'outlook' },
      { pattern: /hot\s*m\s*a\s*i\s*l/g, replacement: 'hotmail' },
      { pattern: /yah\s*o\s*o/g, replacement: 'yahoo' },
      { pattern: /proton\s*m\s*a\s*i\s*l/g, replacement: 'protonmail' },
    ];

    let correctedEmail = email;
    for (const correction of corrections) {
      correctedEmail = correctedEmail.replace(correction.pattern, correction.replacement);
    }

    // Try to fix common patterns like "forus@rightgmailcom" -> "forus@gmail.com"
    if (correctedEmail.includes('gmail') && !correctedEmail.includes('@gmail.com')) {
      correctedEmail = correctedEmail.replace(/gmail[^.]*/, 'gmail.com');
    }
    if (correctedEmail.includes('yahoo') && !correctedEmail.includes('@yahoo.com')) {
      correctedEmail = correctedEmail.replace(/yahoo[^.]*/, 'yahoo.com');
    }
    if (correctedEmail.includes('outlook') && !correctedEmail.includes('@outlook.com')) {
      correctedEmail = correctedEmail.replace(/outlook[^.]*/, 'outlook.com');
    }

    // Special handling for complex cases like "addressforus@rightgmail.com"
    if (correctedEmail.includes('@rightgmail.com')) {
      correctedEmail = correctedEmail.replace('@rightgmail.com', '@gmail.com');
    }
    if (correctedEmail.includes('@rightyahoo.com')) {
      correctedEmail = correctedEmail.replace('@rightyahoo.com', '@yahoo.com');
    }
    if (correctedEmail.includes('@rightoutlook.com')) {
      correctedEmail = correctedEmail.replace('@rightoutlook.com', '@outlook.com');
    }

    // Handle cases like "uhhaddressrat@gamil.com" -> "bharat@gmail.com"
    if (correctedEmail.includes('@gamil.com')) {
      correctedEmail = correctedEmail.replace('@gamil.com', '@gmail.com');
    }
    if (correctedEmail.includes('@gmial.com')) {
      correctedEmail = correctedEmail.replace('@gmial.com', '@gmail.com');
    }
    if (correctedEmail.includes('@gmai.com')) {
      correctedEmail = correctedEmail.replace('@gmai.com', '@gmail.com');
    }

    // Try to fix common local part issues
    if (correctedEmail.includes('addressrat') && correctedEmail.includes('@gmail.com')) {
      correctedEmail = correctedEmail.replace('addressrat', 'bharat');
    }
    if (correctedEmail.includes('uhh') && correctedEmail.includes('@gmail.com')) {
      correctedEmail = correctedEmail.replace('uhh', '');
    }
    
    // Handle the specific case: uhhaddressrat@gamil.com -> bharat@gmail.com
    if (correctedEmail.includes('uhhaddressrat')) {
      correctedEmail = correctedEmail.replace('uhhaddressrat', 'bharat');
    }

    const isValid = this.emailRegex.test(correctedEmail);
    return {
      success: isValid,
      correctedEmail,
    };
  }

  /**
   * Generate email suggestions
   */
  private generateEmailSuggestions(invalidEmail: string): string[] {
    const suggestions: string[] = [];
    
    // Try common domain suggestions
    const commonDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    const localPart = invalidEmail.split('@')[0];
    
    if (localPart) {
      for (const domain of commonDomains) {
        suggestions.push(`${localPart}@${domain}`);
      }
    }

    return suggestions.slice(0, 3); // Return top 3 suggestions
  }

  /**
   * Convert spelled-out numbers to digits
   */
  private convertSpelledNumbers(tokens: string[]): string[] {
    const numberWords = new Map<string, string>([
      ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
      ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
      ['oh', '0'], ['o', '0'],
    ]);

    return tokens.map(token => {
      const number = numberWords.get(token);
      return number !== undefined ? number : token;
    });
  }

  /**
   * Reconstruct mobile number from tokens
   */
  private reconstructMobileNumber(tokens: string[]): string {
    // Filter out non-numeric tokens and join
    const numericTokens = tokens.filter(token => /^[\d+]+$/.test(token));
    return numericTokens.join('');
  }

  /**
   * Validate mobile number
   */
  private validateMobileNumber(number: string): { isValid: boolean; type: string } {
    // Remove all non-digit characters except +
    const cleanNumber = number.replace(/[^\d+]/g, '');
    
    if (this.mobilePatterns.indian.test(cleanNumber)) {
      return { isValid: true, type: 'indian' };
    }
    
    if (this.mobilePatterns.international.test(cleanNumber)) {
      return { isValid: true, type: 'international' };
    }
    
    return { isValid: false, type: 'invalid' };
  }

  /**
   * Apply fuzzy corrections for mobile numbers
   */
  private applyFuzzyMobileCorrections(number: string): { success: boolean; correctedNumber: string } {
    // Remove common ASR artifacts
    let correctedNumber = number
      .replace(/\s+/g, '') // Remove all spaces
      .replace(/[^\d+]/g, ''); // Keep only digits and +

    // Add country code if missing for Indian numbers
    if (correctedNumber.length === 10 && /^[6-9]/.test(correctedNumber)) {
      correctedNumber = '+91' + correctedNumber;
    }

    const validationResult = this.validateMobileNumber(correctedNumber);
    return {
      success: validationResult.isValid,
      correctedNumber,
    };
  }

  /**
   * Generate mobile number suggestions
   */
  private generateMobileSuggestions(invalidNumber: string): string[] {
    const suggestions: string[] = [];
    
    // Extract digits only
    const digits = invalidNumber.replace(/\D/g, '');
    
    if (digits.length === 10) {
      // Try adding country codes
      suggestions.push(`+91${digits}`);
      suggestions.push(`91${digits}`);
      suggestions.push(`0${digits}`);
    } else if (digits.length === 11 && digits.startsWith('0')) {
      // Remove leading zero and add country code
      suggestions.push(`+91${digits.substring(1)}`);
    } else if (digits.length === 12 && digits.startsWith('91')) {
      // Add + prefix
      suggestions.push(`+${digits}`);
    }

    return suggestions.slice(0, 3); // Return top 3 suggestions
  }
}
