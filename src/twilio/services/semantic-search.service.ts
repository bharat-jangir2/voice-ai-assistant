import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';

export interface SemanticQuery {
  originalQuery: string;
  expandedQueries: string[];
  intent: string;
  entities: string[];
  context: string;
}

export interface SemanticSearchResult {
  content: string;
  score: number;
  fileId: string;
  fileName: string;
  chunkIndex: number;
  totalChunks: number;
  semanticScore: number;
  relevanceScore: number;
  matchedTerms: string[];
  context: string;
}

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(private readonly embeddingService: EmbeddingService) {}

  /**
   * Enhance query with semantic understanding
   */
  async enhanceQuery(query: string): Promise<SemanticQuery> {
    try {
      const lowerQuery = query.toLowerCase().trim();

      // Extract intent
      const intent = this.extractIntent(lowerQuery);

      // Extract entities
      const entities = this.extractEntities(query);

      // Generate expanded queries
      const expandedQueries = this.generateExpandedQueries(query, intent, entities);

      // Determine context
      const context = this.determineContext(query, intent);

      return {
        originalQuery: query,
        expandedQueries,
        intent,
        entities,
        context,
      };
    } catch (error) {
      this.logger.error(`Failed to enhance query: ${error.message}`);
      return {
        originalQuery: query,
        expandedQueries: [query],
        intent: 'general',
        entities: [],
        context: 'general',
      };
    }
  }

  /**
   * Extract search intent from query
   */
  private extractIntent(query: string): string {
    const lowerQuery = query.toLowerCase();

    // Factual queries
    if (
      lowerQuery.includes('what') ||
      lowerQuery.includes('who') ||
      lowerQuery.includes('when') ||
      lowerQuery.includes('where') ||
      lowerQuery.includes('how') ||
      lowerQuery.includes('which')
    ) {
      return 'factual';
    }

    // Definition queries
    if (
      lowerQuery.includes('define') ||
      lowerQuery.includes('definition') ||
      lowerQuery.includes('meaning') ||
      lowerQuery.includes('what is') ||
      lowerQuery.includes('what are') ||
      lowerQuery.includes('definition of')
    ) {
      return 'definition';
    }

    // Comparison queries
    if (
      lowerQuery.includes('compare') ||
      lowerQuery.includes('difference') ||
      lowerQuery.includes('versus') ||
      lowerQuery.includes('vs') ||
      lowerQuery.includes('better')
    ) {
      return 'comparison';
    }

    // Instruction queries
    if (
      lowerQuery.includes('how to') ||
      lowerQuery.includes('steps') ||
      lowerQuery.includes('process') ||
      lowerQuery.includes('tutorial') ||
      lowerQuery.includes('guide')
    ) {
      return 'instruction';
    }

    // List queries
    if (
      lowerQuery.includes('list') ||
      lowerQuery.includes('all') ||
      lowerQuery.includes('examples') ||
      lowerQuery.includes('types') ||
      lowerQuery.includes('kinds')
    ) {
      return 'list';
    }

    // Problem-solving queries
    if (
      lowerQuery.includes('problem') ||
      lowerQuery.includes('issue') ||
      lowerQuery.includes('error') ||
      lowerQuery.includes('fix') ||
      lowerQuery.includes('solve') ||
      lowerQuery.includes('troubleshoot')
    ) {
      return 'problem_solving';
    }

    return 'general';
  }

  /**
   * Extract entities from query
   */
  private extractEntities(query: string): string[] {
    const entities: string[] = [];

    // Person names (capitalized words) - both single and double names
    const personMatches = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g);
    if (personMatches) {
      entities.push(
        ...personMatches.filter(
          (name) =>
            ![
              'The',
              'This',
              'That',
              'These',
              'Those',
              'When',
              'Where',
              'What',
              'Who',
              'How',
              'Why',
              'Is',
              'Are',
              'Was',
              'Were',
              'Will',
              'Can',
              'Could',
              'Should',
              'Would',
            ].includes(name),
        ),
      );
    }

    // Years
    const yearMatches = query.match(/\b(19|20)\d{2}\b/g);
    if (yearMatches) {
      entities.push(...yearMatches);
    }

    // Numbers
    const numberMatches = query.match(/\b\d+\b/g);
    if (numberMatches) {
      entities.push(...numberMatches);
    }

    // Technical terms (words with specific patterns)
    const techMatches = query.match(/\b[a-z]+[A-Z][a-z]*\b/g);
    if (techMatches) {
      entities.push(...techMatches);
    }

    // Common technical terms
    const commonTechTerms = ['API', 'SQL', 'HTML', 'CSS', 'JS', 'PHP', 'XML', 'JSON', 'HTTP', 'HTTPS', 'URL', 'URI'];
    commonTechTerms.forEach((term) => {
      if (query.toUpperCase().includes(term)) {
        entities.push(term);
      }
    });

    // Programming languages and frameworks
    const programmingTerms = [
      'Python',
      'Java',
      'JavaScript',
      'TypeScript',
      'C++',
      'C#',
      'Go',
      'Rust',
      'Swift',
      'Kotlin',
      'React',
      'Vue',
      'Angular',
      'Node',
      'Express',
      'Django',
      'Flask',
      'Spring',
      'Laravel',
    ];
    programmingTerms.forEach((term) => {
      if (query.includes(term)) {
        entities.push(term);
      }
    });

    return [...new Set(entities)]; // Remove duplicates
  }

  /**
   * Generate expanded queries for better semantic matching
   */
  private generateExpandedQueries(originalQuery: string, intent: string, entities: string[]): string[] {
    const expandedQueries = [originalQuery];
    const lowerQuery = originalQuery.toLowerCase();

    // Add synonym-based expansions
    const synonyms = this.getSynonyms(originalQuery);
    expandedQueries.push(...synonyms);

    // Add entity-focused queries
    entities.forEach((entity) => {
      if (!lowerQuery.includes(entity.toLowerCase())) {
        expandedQueries.push(`${originalQuery} ${entity}`);
      }
    });

    // Add intent-specific expansions
    switch (intent) {
      case 'factual':
        expandedQueries.push(`information about ${originalQuery}`);
        expandedQueries.push(`details about ${originalQuery}`);
        break;
      case 'definition':
        expandedQueries.push(`explain ${originalQuery}`);
        expandedQueries.push(`describe ${originalQuery}`);
        break;
      case 'instruction':
        expandedQueries.push(`steps for ${originalQuery}`);
        expandedQueries.push(`how do I ${originalQuery}`);
        break;
      case 'comparison':
        expandedQueries.push(`differences in ${originalQuery}`);
        expandedQueries.push(`compare ${originalQuery}`);
        break;
    }

    // Add context variations
    if (lowerQuery.includes('born')) {
      expandedQueries.push(originalQuery.replace(/born/gi, 'birth'));
      expandedQueries.push(originalQuery.replace(/born/gi, 'birthday'));
    }

    if (lowerQuery.includes('age')) {
      expandedQueries.push(originalQuery.replace(/age/gi, 'old'));
      expandedQueries.push(originalQuery.replace(/age/gi, 'years'));
    }

    return [...new Set(expandedQueries)]; // Remove duplicates
  }

  /**
   * Get synonyms for query expansion
   */
  private getSynonyms(query: string): string[] {
    const synonymMap: Record<string, string[]> = {
      born: ['birth', 'birthday', 'birthdate'],
      age: ['old', 'years', 'age'],
      name: ['called', 'named', 'identity'],
      where: ['location', 'place', 'address'],
      when: ['time', 'date', 'year'],
      how: ['method', 'way', 'process'],
      what: ['which', 'that', 'thing'],
      who: ['person', 'individual', 'someone'],
      old: ['age', 'years', 'elderly'],
      young: ['new', 'recent', 'fresh'],
      big: ['large', 'huge', 'enormous'],
      small: ['tiny', 'little', 'mini'],
      good: ['great', 'excellent', 'wonderful'],
      bad: ['terrible', 'awful', 'poor'],
      fast: ['quick', 'rapid', 'speedy'],
      slow: ['sluggish', 'gradual', 'delayed'],
    };

    const synonyms: string[] = [];
    const lowerQuery = query.toLowerCase();

    Object.entries(synonymMap).forEach(([key, values]) => {
      if (lowerQuery.includes(key)) {
        values.forEach((synonym) => {
          synonyms.push(query.replace(new RegExp(key, 'gi'), synonym));
        });
      }
    });

    return synonyms;
  }

  /**
   * Determine context from query
   */
  private determineContext(query: string, intent: string): string {
    const lowerQuery = query.toLowerCase();

    // Technical context
    if (
      lowerQuery.includes('code') ||
      lowerQuery.includes('programming') ||
      lowerQuery.includes('software') ||
      lowerQuery.includes('api') ||
      lowerQuery.includes('database') ||
      lowerQuery.includes('server')
    ) {
      return 'technical';
    }

    // Personal context
    if (
      lowerQuery.includes('born') ||
      lowerQuery.includes('age') ||
      lowerQuery.includes('name') ||
      lowerQuery.includes('person') ||
      lowerQuery.includes('individual') ||
      lowerQuery.includes('old')
    ) {
      return 'personal';
    }

    // Business context
    if (
      lowerQuery.includes('company') ||
      lowerQuery.includes('business') ||
      lowerQuery.includes('organization') ||
      lowerQuery.includes('employee') ||
      lowerQuery.includes('customer')
    ) {
      return 'business';
    }

    // Educational context
    if (
      lowerQuery.includes('learn') ||
      lowerQuery.includes('study') ||
      lowerQuery.includes('education') ||
      lowerQuery.includes('course') ||
      lowerQuery.includes('tutorial')
    ) {
      return 'educational';
    }

    return 'general';
  }

  /**
   * Calculate semantic relevance score
   */
  calculateSemanticRelevance(query: string, content: string, matchedTerms: string[]): number {
    let score = 0;
    const lowerQuery = query.toLowerCase();
    const lowerContent = content.toLowerCase();

    // Base score from matched terms
    score += matchedTerms.length * 0.1;

    // Intent matching bonus
    const intent = this.extractIntent(query);
    if (intent === 'factual' && this.containsFactualContent(content)) {
      score += 0.2;
    }

    // Entity matching bonus
    const entities = this.extractEntities(query);
    const entityMatches = entities.filter((entity) => lowerContent.includes(entity.toLowerCase())).length;
    score += entityMatches * 0.15;

    // Context matching bonus
    const context = this.determineContext(query, intent);
    if (this.matchesContext(content, context)) {
      score += 0.1;
    }

    // Query term density bonus
    const queryTerms = lowerQuery.split(/\s+/).filter((term) => term.length > 2);
    const termMatches = queryTerms.filter((term) => lowerContent.includes(term)).length;
    score += (termMatches / queryTerms.length) * 0.2;

    return Math.min(score, 1.0); // Cap at 1.0
  }

  /**
   * Check if content contains factual information
   */
  private containsFactualContent(content: string): boolean {
    const factualPatterns = [
      /\b(19|20)\d{2}\b/, // Years
      /\b\d+\s*(years?|months?|days?)\s*old\b/i, // Ages
      /\b(was|is|were|are)\s+(born|created|established|founded)\b/i, // Birth/creation
      /\b(in|at|from)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/, // Locations
    ];

    return factualPatterns.some((pattern) => pattern.test(content));
  }

  /**
   * Check if content matches context
   */
  private matchesContext(content: string, context: string): boolean {
    const lowerContent = content.toLowerCase();

    switch (context) {
      case 'technical':
        return /\b(code|programming|software|api|database|server|function|class|method)\b/i.test(lowerContent);
      case 'personal':
        return /\b(born|age|name|person|individual|birth|birthday)\b/i.test(lowerContent);
      case 'business':
        return /\b(company|business|organization|employee|customer|revenue|profit)\b/i.test(lowerContent);
      case 'educational':
        return /\b(learn|study|education|course|tutorial|lesson|chapter)\b/i.test(lowerContent);
      default:
        return true;
    }
  }

  /**
   * Extract matched terms from content
   */
  extractMatchedTerms(query: string, content: string): string[] {
    const matchedTerms: string[] = [];
    const lowerQuery = query.toLowerCase();
    const lowerContent = content.toLowerCase();

    // Extract query terms that appear in content
    const queryTerms = lowerQuery.split(/\s+/).filter((term) => term.length > 2);
    queryTerms.forEach((term) => {
      if (lowerContent.includes(term)) {
        matchedTerms.push(term);
      }
    });

    // Extract entities that appear in content
    const entities = this.extractEntities(query);
    entities.forEach((entity) => {
      if (lowerContent.includes(entity.toLowerCase())) {
        matchedTerms.push(entity);
      }
    });

    return [...new Set(matchedTerms)]; // Remove duplicates
  }
}
