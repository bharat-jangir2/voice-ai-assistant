import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface DomainWord {
  correct: string;
  variations: string[];
}

@Injectable()
export class WordCorrectionService {
  private readonly logger = new Logger(WordCorrectionService.name);
  private readonly domainWords: Map<string, DomainWord[]>;

  constructor(private readonly configService: ConfigService) {
    // Initialize domain-specific words and their variations
    this.domainWords = new Map([
      [
        'speedel',
        [
          {
            correct: 'Speedel',
            variations: [
              'Fiddle',
              'Spiddle',
              'Spedel',
              'Spedle',
              'Speedle',
              'Speedal',
              'Speedil',
              'Speetel',
              'Spittel',
              'Spidil',
              'Speeddle',
              'speed dial',
              'Speedle',
              'speed up',
            ],
          },
        ],
      ],
      [
        'appraisee',
        [
          {
            correct: 'Appraisee',
            variations: [
              'appraised',
              'aprezi',
              'fizzy',
              'Appresis',
              'Appreezy',
              'Crazy',
              'Prezi',
              'Prey',
              'Appraise',
              'Appraize',
              'Appraizy',
              'Appraizee',
              'Apraisee',
              'Aprayzee',
              'Apprasie',
              'Apprizee',
              'Apprezzy',
              'Apprezzi',
              'Apresy',
              'Apprize',
              'Apprize',
              'Aprezee',
              'Aprezzi',
            ],
          },
          {
            correct: 'Appraisee',
            variations: [
              // Existing variations
              'Appraise',
              'Appraize',
              'Appraizy',
              'Appraizee',
              'Apraisee',
              'Aprayzee',
              'Apprasie',
              'Apprizee',
              'Apprezzy',
              'Apprezzi',
              'Apresy',
              'Apprize',
              'Aprezee',
              'Aprezzi',

              // Additional common variations
              'Appraisey',
              'Appraisy',
              'Appraizey',
              'Appraizi',
              'Apprazi',
              'Apprazee',
              'Apprazey',
              'Apprazy',
              'Appraysi',
              'Appraysee',
              'Appreysi',
              'Appreysee',
              'Appreyzy',
              'Apprezy',
              'Apprizey',
              'Apprizy',
              'Appraisie',
              'Appraisye',
              'Appraisay',
              'Appraisai',

              // Phonetic variations
              'Aprayzi',
              'Aprayzey',
              'Apraysey',
              'Apraysy',
              'Apreyzi',
              'Apreyzy',
              'Apreysy',
              'Apreysey',
              'Aprazi',
              'Aprazey',
              'Aprasey',
              'Aprasy',

              // Single 'p' variations
              'Apraise',
              'Apraize',
              'Apraizy',
              'Apraizee',
              'Aprizee',
              'Aprezzy',
              'Aprezzi',
              'Aprize',
              'Aprizy',
              'Aprazy',
              'Aprazee',

              // Shortened/truncated versions
              'Apprais',
              'Apprays',
              'Appriz',
              'Apprez',
              'Apraiz',
              'Aprays',
              'Apriz',
              'Aprez',

              // With 'ee' sound variations
              'Appraiseey',
              'Appraiseyy',
              'Appraizeey',
              'Appraizeyy',
              'Apprezeeey',
              'Apprezeey',

              // Double letter variations
              'Apppraisee',
              'Apprraaisee',
              'Appraiisee',
              'Appraissse',
              'Apprraizzee',

              // 'A' sound variations
              'Eppraisee',
              'Uppraisee',
              'Oppraisee',
              'Ippraisee',

              // Soft consonant variations
              'Abraisee',
              'Abraise',
              'Abraize',
              'Abraizee',
              'Abrasee',
              'Abrase',
              'Abreasee',
              'Abrease',

              // Mixed variations
              'Apbrasee',
              'Apbrase',
              'Apbraise',
              'Apbraize',
              'Apvrasee',
              'Apvrase',
              'Apvraise',
              'Apvraize',
            ],
          },
        ],
      ],
      [
        'prep my vehicle',
        [
          {
            correct: 'Prep My Vehicle',
            variations: [
              'Prep My Vehical',
              'Prep My Vehickle',
              'Prep My Vehickel',
              'Prep My Waeckle',
              'Prep My Vaikal',
              'Prep My Veehicle',
              'Prep My Wehikal',
            ],
          },
        ],
      ],
    ]);
  }

  /**
   * Corrects domain-specific words in the transcribed text
   * @param text The transcribed text to correct
   * @returns The corrected text
   */
  correctDomainWords(text: string): string {
    if (!text) return text;

    let correctedText = text;
    const words = text.split(' ');

    // Check for multi-word phrases first (like "prep my vehicle")
    for (const [phrase, corrections] of this.domainWords.entries()) {
      if (text.toLowerCase().includes(phrase.toLowerCase())) {
        for (const correction of corrections) {
          for (const variation of correction.variations) {
            const regex = new RegExp(variation, 'gi');
            if (regex.test(correctedText)) {
              this.logger.debug(`Correcting "${variation}" to "${correction.correct}"`);
              correctedText = correctedText.replace(regex, correction.correct);
            }
          }
        }
      }
    }

    // Check individual words
    for (const [word, corrections] of this.domainWords.entries()) {
      if (word.split(' ').length === 1) {
        // Only process single words
        for (const correction of corrections) {
          for (const variation of correction.variations) {
            const regex = new RegExp(`\\b${variation}\\b`, 'gi');
            if (regex.test(correctedText)) {
              this.logger.debug(`Correcting "${variation}" to "${correction.correct}"`);
              correctedText = correctedText.replace(regex, correction.correct);
            }
          }
        }
      }
    }

    if (correctedText !== text) {
      this.logger.debug(`Corrected transcription: "${text}" -> "${correctedText}"`);
    }

    return correctedText;
  }
}
