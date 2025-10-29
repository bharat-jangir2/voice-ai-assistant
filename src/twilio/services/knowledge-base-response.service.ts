import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeBaseSearchResult } from './knowledge-base-search.service';

export interface FineTunedResponse {
  content: string;
  sources: string[];
  confidence: 'high' | 'medium' | 'low';
  isFromKnowledgeBase: boolean;
}

@Injectable()
export class KnowledgeBaseResponseService {
  private readonly logger = new Logger(KnowledgeBaseResponseService.name);

  /**
   * Create a fine-tuned response based on knowledge base results
   */
  createFineTunedResponse(query: string, kbResults: KnowledgeBaseSearchResult[], fallbackResponse?: string): FineTunedResponse {
    try {
      if (kbResults.length === 0) {
        return {
          content: fallbackResponse || "I don't have specific information about that in my knowledge base.",
          sources: [],
          confidence: 'low',
          isFromKnowledgeBase: false,
        };
      }

      // Analyze results to determine confidence
      const confidence = this.analyzeConfidence(kbResults);

      // Create response based on confidence level
      let content: string;
      let sources: string[];

      if (confidence === 'high') {
        // High confidence: Use KB content directly with minimal AI processing
        content = this.createHighConfidenceResponse(query, kbResults);
        sources = this.extractSources(kbResults);
      } else if (confidence === 'medium') {
        // Medium confidence: Combine KB content with AI processing
        content = this.createMediumConfidenceResponse(query, kbResults);
        sources = this.extractSources(kbResults);
      } else {
        // Low confidence: Use KB as context but rely more on AI
        content = this.createLowConfidenceResponse(query, kbResults, fallbackResponse);
        sources = this.extractSources(kbResults);
      }

      return {
        content,
        sources,
        confidence,
        isFromKnowledgeBase: true,
      };
    } catch (error) {
      this.logger.error(`Failed to create fine-tuned response: ${error.message}`);
      return {
        content: fallbackResponse || 'I encountered an error processing your request.',
        sources: [],
        confidence: 'low',
        isFromKnowledgeBase: false,
      };
    }
  }

  /**
   * Analyze confidence based on search results
   */
  private analyzeConfidence(results: KnowledgeBaseSearchResult[]): 'high' | 'medium' | 'low' {
    if (results.length === 0) return 'low';

    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    const maxScore = Math.max(...results.map((r) => r.score));
    const resultCount = results.length;

    // High confidence: Very high scores and multiple results
    if (avgScore >= 0.85 && maxScore >= 0.9 && resultCount >= 2) {
      return 'high';
    }

    // Medium confidence: Good scores (lowered threshold for better matching)
    // Single result with score >= 0.4 or multiple results with avg >= 0.35
    if (maxScore >= 0.4 || (resultCount >= 2 && avgScore >= 0.35)) {
      return 'medium';
    }

    // Low confidence: Lower scores
    return 'low';
  }

  /**
   * Create high confidence response (direct from KB)
   */
  private createHighConfidenceResponse(query: string, results: KnowledgeBaseSearchResult[]): string {
    // For high confidence, extract specific answer from the best result
    const bestResult = results[0];
    let content = bestResult.content.trim();

    // Try to extract specific answer based on query type
    const extractedAnswer = this.extractSpecificAnswer(query, content);
    if (extractedAnswer) {
      content = extractedAnswer;
    } else {
      // Fallback to original content processing
      content = this.cleanContent(content);
    }

    // Add source attribution
    const source = `(Source: ${bestResult.fileName})`;
    return `${content} ${source}`;
  }

  /**
   * Extract specific answer from content based on query type
   */
  private extractSpecificAnswer(query: string, content: string): string | null {
    const lowerQuery = query.toLowerCase();
    const lowerContent = content.toLowerCase();

    // Extract person name from query for better matching
    const personName = this.extractPersonName(query);
    const namePrefix = personName ? `${personName} ` : '';

    // Date/Year extraction patterns
    if (lowerQuery.includes('born') || lowerQuery.includes('birth')) {
      const yearMatch = content.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        return `${namePrefix}was born in ${yearMatch[0]}.`;
      }
    }

    // Age extraction
    if (lowerQuery.includes('age') || lowerQuery.includes('old')) {
      const ageMatch = content.match(/\b(\d{1,2})\s*years?\s*old\b/i);
      if (ageMatch) {
        return `${namePrefix}is ${ageMatch[1]} years old.`;
      }
    }

    // Location extraction
    if (lowerQuery.includes('where') || lowerQuery.includes('location') || lowerQuery.includes('place')) {
      const locationMatch = content.match(/\b(?:in|at|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
      if (locationMatch) {
        return `${namePrefix}is from ${locationMatch[1]}.`;
      }
    }

    // Name extraction
    if (lowerQuery.includes('name') || lowerQuery.includes('who')) {
      const nameMatch = content.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/);
      if (nameMatch) {
        return `The person mentioned is ${nameMatch[1]}.`;
      }
    }

    // Number extraction (for quantities, amounts, etc.)
    if (lowerQuery.includes('how many') || lowerQuery.includes('count') || lowerQuery.includes('number')) {
      const numberMatch = content.match(/\b(\d+)\b/);
      if (numberMatch) {
        return `The answer is ${numberMatch[1]}.`;
      }
    }

    // When/Time extraction
    if (lowerQuery.includes('when') || lowerQuery.includes('birth year') || lowerQuery.includes('what is the')) {
      const yearMatch = content.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        return `The answer is ${yearMatch[0]}.`;
      }
    }

    // Simple factual extraction - look for patterns like "X was born in Y"
    if (lowerQuery.includes('born') && content.includes('born')) {
      const bornMatch = content.match(/(\w+)\s+was\s+born\s+in\s+(\d{4})/i);
      if (bornMatch) {
        return `${bornMatch[1]} was born in ${bornMatch[2]}.`;
      }
    }

    // Extract query keywords (remove common words) - used for all generic extractions
    const queryKeywords = lowerQuery
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          ![
            'how',
            'can',
            'what',
            'where',
            'when',
            'why',
            'the',
            'for',
            'with',
            'i',
            'to',
            'we',
            'you',
            'do',
            'does',
            'is',
            'are',
            'was',
            'were',
          ].includes(w),
      );

    // Try structured data extraction first (commands, steps, definitions, Q&A)
    const structuredData = this.extractStructuredData(query, content, queryKeywords, lowerQuery);
    if (structuredData) {
      return structuredData;
    }

    // Fallback to semantic extraction - find most relevant sentences
    const semanticExtract = this.extractSemanticAnswer(query, content, queryKeywords, lowerQuery);
    if (semanticExtract) {
      return semanticExtract;
    }

    // If no specific pattern matches, return null to use fallback
    return null;
  }

  /**
   * Extract person name from query for better response formatting
   */
  private extractPersonName(query: string): string | null {
    // Look for common patterns like "when was X born", "X was born", etc.
    const patterns = [
      /when\s+was\s+(\w+)\s+born/i,
      /(\w+)\s+was\s+born/i,
      /(\w+)\s+is\s+born/i,
      /(\w+)\s+birth/i,
      /how\s+old\s+is\s+(\w+)/i,
      /(\w+)\s+age/i,
    ];

    for (const pattern of patterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Extract structured data (commands, steps, definitions, Q&A, etc.)
   * Works with various content formats - not specific to any file type
   */
  private extractStructuredData(query: string, content: string, queryKeywords: string[], lowerQuery: string): string | null {
    // Pattern 1: Command format (Command: ... Use Case: ...)
    const commandPattern = /(?:^|\n)(?:\d+\.\s*)?([^\n]+?)\s*\n\s*Command:\s*([^\n]+)\s*\n\s*Use Case:\s*([^\n]+)/gim;
    const commandMatches = [...content.matchAll(commandPattern)];

    if (commandMatches.length > 0) {
      const bestMatch = this.findBestMatch(commandMatches, queryKeywords, lowerQuery, (match) => match[1]);
      if (bestMatch) {
        return `Command: ${bestMatch[2].trim()}\n\nUse Case: ${bestMatch[3].trim()}`;
      }
    }

    // Pattern 2: Definition format (Term: Definition or Term - Definition)
    const definitionPattern = /(?:^|\n)([A-Z][^\n:]+?):\s*([^\n]+)/g;
    const definitionMatches = [...content.matchAll(definitionPattern)];

    if (
      definitionMatches.length > 0 &&
      (lowerQuery.includes('what is') || lowerQuery.includes('what are') || lowerQuery.includes('define'))
    ) {
      const bestMatch = this.findBestMatch(definitionMatches, queryKeywords, lowerQuery, (match) => match[1]);
      if (bestMatch && bestMatch[2].trim().length > 20) {
        return `${bestMatch[1].trim()}: ${bestMatch[2].trim()}`;
      }
    }

    // Pattern 3: Step format (Step N: ... or N. Step ...)
    const stepPattern = /(?:^|\n)(?:\d+\.\s*|Step\s+\d+[:.]\s*)([^\n]+)/gim;
    const stepMatches = [...content.matchAll(stepPattern)];

    if (stepMatches.length > 0 && (lowerQuery.includes('how') || lowerQuery.includes('step'))) {
      // Find steps that contain query keywords
      const relevantSteps = stepMatches
        .filter((match) => {
          const stepText = match[1].toLowerCase();
          return queryKeywords.some((keyword) => stepText.includes(keyword));
        })
        .slice(0, 3); // Limit to top 3 relevant steps

      if (relevantSteps.length > 0) {
        return relevantSteps.map((match) => match[1].trim()).join('\n\n');
      }
    }

    // Pattern 4: Question-Answer format (Q: ... A: ...)
    const qaPattern = /(?:^|\n)(?:Q|Question)[:.]\s*([^\n]+)\s*\n(?:A|Answer)[:.]\s*([^\n]+)/gim;
    const qaMatches = [...content.matchAll(qaPattern)];

    if (qaMatches.length > 0) {
      const bestMatch = this.findBestMatch(qaMatches, queryKeywords, lowerQuery, (match) => match[1]);
      if (bestMatch) {
        return bestMatch[2].trim();
      }
    }

    // Pattern 5: Bullet points or list items
    const listPattern = /(?:^|\n)[\-\*•]\s*([^\n]+)/gim;
    const listMatches = [...content.matchAll(listPattern)];

    if (listMatches.length > 0) {
      const relevantItems = listMatches
        .filter((match) => {
          const itemText = match[1].toLowerCase();
          return queryKeywords.some((keyword) => itemText.includes(keyword));
        })
        .slice(0, 3);

      if (relevantItems.length > 0) {
        return relevantItems.map((match) => match[1].trim()).join('\n\n');
      }
    }

    return null;
  }

  /**
   * Generic semantic extraction - find most relevant sentences/paragraphs
   * Works for any unstructured content
   */
  private extractSemanticAnswer(query: string, content: string, queryKeywords: string[], lowerQuery: string): string | null {
    // Split content into sentences (handle different delimiters)
    const sentences = content
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20); // Filter out very short sentences

    if (sentences.length === 0) {
      return null;
    }

    // Score each sentence based on keyword matches
    const scoredSentences = sentences.map((sentence) => {
      const lowerSentence = sentence.toLowerCase();
      let score = queryKeywords.reduce((s, keyword) => {
        if (lowerSentence.includes(keyword)) {
          return s + 1;
        }
        return s;
      }, 0);

      // Bonus for exact phrase matches
      if (lowerSentence.includes(lowerQuery)) {
        score += 2;
      }

      return { sentence, score };
    });

    // Sort by score and get top matches
    const topMatches = scoredSentences
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2); // Get top 2 most relevant sentences

    if (topMatches.length > 0 && topMatches[0].score > 0) {
      const result = topMatches
        .map((item) => item.sentence)
        .join('. ')
        .trim();
      if (result.length > 0 && result.length < 500) {
        return result;
      }
    }

    return null;
  }

  /**
   * Find the best matching item from an array of matches based on query keywords
   * Generic helper that works for any structured data format
   */
  private findBestMatch<T extends RegExpMatchArray>(
    matches: T[],
    queryKeywords: string[],
    lowerQuery: string,
    getTitle: (match: T) => string,
  ): T | null {
    let bestMatch: T | null = null;
    let bestScore = 0;

    for (const match of matches) {
      const title = getTitle(match);
      const titleLower = title.toLowerCase();
      const titleWithoutNumber = titleLower.replace(/^\d+\.\s*/, '');
      const titleWords = titleWithoutNumber.split(/\s+/).filter((w) => w.length > 2);

      // Calculate match score
      const matchScore = queryKeywords.reduce((score, keyword) => {
        if (titleWords.some((tw) => tw.includes(keyword) || keyword.includes(tw))) {
          return score + 1;
        }
        return score;
      }, 0);

      // Bonus for exact phrase match
      if (titleLower.includes(lowerQuery) || lowerQuery.includes(titleLower)) {
        if (matchScore > bestScore) {
          bestScore = matchScore + 2;
          bestMatch = match;
        }
      } else if (matchScore > bestScore) {
        bestScore = matchScore;
        bestMatch = match;
      }
    }

    // Return best match if score is good enough or query contains certain triggers
    if (
      bestMatch &&
      (bestScore > 0 || lowerQuery.includes('how') || lowerQuery.includes('what') || lowerQuery.includes('view'))
    ) {
      return bestMatch;
    }

    return null;
  }

  /**
   * Clean content for better presentation
   */
  private cleanContent(content: string): string {
    // Remove any "Question:" or "Answer:" prefixes if present
    let cleaned = content.replace(/^(Question:\s*|Answer:\s*)/i, '');

    // Ensure it ends with proper punctuation
    if (!cleaned.match(/[.!?]$/)) {
      cleaned += '.';
    }

    return cleaned;
  }

  /**
   * Create medium confidence response (KB + AI processing)
   */
  private createMediumConfidenceResponse(query: string, results: KnowledgeBaseSearchResult[]): string {
    // Try to extract specific answer from best result first
    const bestResult = results[0];
    const extracted = this.extractSpecificAnswer(query, bestResult.content);

    // If extraction succeeds for the best result, use it
    if (extracted) {
      const sources = [...new Set(results.slice(0, 3).map((r) => r.fileName))];
      return extracted + (sources.length > 0 ? ` (Sources: ${sources.join(', ')})` : '');
    }

    // Try extraction from other results
    const extractedAnswers: string[] = [];
    for (const result of results.slice(1, 3)) {
      const extracted = this.extractSpecificAnswer(query, result.content);
      if (extracted) {
        extractedAnswers.push(extracted);
      }
    }

    // If we found specific answers from other results, use them
    if (extractedAnswers.length > 0) {
      const uniqueAnswers = [...new Set(extractedAnswers)];
      let content = uniqueAnswers.join('\n\n');

      // Add source attribution
      const sources = [...new Set(results.slice(0, 3).map((r) => r.fileName))];
      content += ` (Sources: ${sources.join(', ')})`;

      return content;
    }

    // Fallback: Return the best matching result content directly
    if (results.length > 0) {
      const sources = [...new Set(results.map((r) => r.fileName))];
      return `${bestResult.content.trim()} (Sources: ${sources.join(', ')})`;
    }

    return "I couldn't find specific information about that.";
  }

  /**
   * Create low confidence response (KB as context)
   */
  private createLowConfidenceResponse(query: string, results: KnowledgeBaseSearchResult[], fallbackResponse?: string): string {
    // Try to extract specific answer first
    const bestResult = results[0];
    const extractedAnswer = this.extractSpecificAnswer(query, bestResult.content);

    if (extractedAnswer) {
      const sources = [...new Set(results.map((r) => r.fileName))];
      return extractedAnswer + (sources.length > 0 ? ` (Sources: ${sources.join(', ')})` : '');
    }

    // Use KB results as context
    const context = results
      .slice(0, 2)
      .map((r) => r.content.trim())
      .join(' ');

    // Only use fallback if it's not an error message
    const isErrorFallback =
      fallbackResponse &&
      (fallbackResponse.toLowerCase().includes('error') ||
        fallbackResponse.toLowerCase().includes('apologize') ||
        fallbackResponse.toLowerCase().includes('encountered'));

    let content = isErrorFallback
      ? "I found some related information, but I'm not entirely certain about the specific details."
      : fallbackResponse || "I found some related information, but I'm not entirely certain about the specific details.";

    if (context) {
      content += ` Here's what I found: ${context}`;
    }

    // Add source attribution
    const sources = [...new Set(results.map((r) => r.fileName))];
    if (sources.length > 0) {
      content += ` (Sources: ${sources.join(', ')})`;
    }

    return content;
  }

  /**
   * Extract unique sources from results
   */
  private extractSources(results: KnowledgeBaseSearchResult[]): string[] {
    return [...new Set(results.map((r) => r.fileName))];
  }

  /**
   * Create a concise summary of KB results for AI context
   */
  createConciseContext(results: KnowledgeBaseSearchResult[]): string {
    if (results.length === 0) {
      return '';
    }

    // Group by file and take best result from each
    const fileResults = new Map<string, KnowledgeBaseSearchResult>();

    results.forEach((result) => {
      const existing = fileResults.get(result.fileName);
      if (!existing || result.score > existing.score) {
        fileResults.set(result.fileName, result);
      }
    });

    let context = 'Relevant knowledge base information:\n';

    Array.from(fileResults.values()).forEach((result, index) => {
      context += `${index + 1}. [${result.fileName}] ${result.content.substring(0, 200)}${result.content.length > 200 ? '...' : ''}\n`;
    });

    return context;
  }

  /**
   * Validate if response should use KB results
   */
  shouldUseKnowledgeBase(results: KnowledgeBaseSearchResult[]): boolean {
    if (results.length === 0) return false;

    // Use KB if we have any results - let the extraction logic handle quality
    // Lowered threshold significantly to catch more relevant matches
    return results.some((r) => r.score >= 0.25);
  }

  /**
   * Get response metadata for logging
   */
  getResponseMetadata(results: KnowledgeBaseSearchResult[]): {
    resultCount: number;
    avgScore: number;
    maxScore: number;
    files: string[];
  } {
    return {
      resultCount: results.length,
      avgScore: results.length > 0 ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0,
      maxScore: results.length > 0 ? Math.max(...results.map((r) => r.score)) : 0,
      files: [...new Set(results.map((r) => r.fileName))],
    };
  }
}
