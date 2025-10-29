import { Injectable, Logger } from '@nestjs/common';
import { AIResponseService } from './ai-response.service';
import { SpeechService } from './speech.service';
import { WordCorrectionService } from './word-correction.service';
import { BookingFlowService } from './booking-flow.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AudioProcessingService {
  private readonly logger = new Logger(AudioProcessingService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly speechService: SpeechService,
    private readonly aiResponseService: AIResponseService,
    private readonly wordCorrectionService: WordCorrectionService,
    private readonly bookingFlowService: BookingFlowService,
    // private readonly whisperService: WhisperService, // Available if needed
  ) {}

  async processAudioChunks(
    assistantType: string,
    chunkMap: Map<number, Buffer>,
    sendResponseToCaller: (response: string) => Promise<void>,
    threadId?: string,
    callSid?: string,
    phoneNumber?: string,
    conversationEventCallback?: (eventType: string, data: any) => void,
  ) {
    try {
      this.logger.verbose(`
        ✅ Processing ${chunkMap.size} audio chunks...
      `);

      const sortedChunks = Array.from(chunkMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, buffer]) => buffer);
      const combinedBuffer = Buffer.concat(sortedChunks);

      if (!combinedBuffer || combinedBuffer.length === 0) {
        this.logger.warn('Combined buffer is empty, skipping processing');
        return;
      }

      const STTProvider = this.configService.get('STT_PROVIDER');
      const transcriptionStartTime = Date.now();
      let originalTranscription = await this.speechService.transcribe(combinedBuffer, STTProvider);
      const transcriptionTime = Date.now() - transcriptionStartTime;

      if (!originalTranscription || originalTranscription.trim().length === 0) {
        this.logger.warn('Transcription is empty, skipping AI response generation.');
        return;
      }

      // Apply domain-specific word corrections
      const correctedTranscription = this.wordCorrectionService.correctDomainWords(originalTranscription);

      this.logger.verbose(`
        ✅ Speech-to-text (STT): ${STTProvider}
           Original Transcription Text : "${originalTranscription}"
           Corrected Transcription Text : "${correctedTranscription}"
           Time taken : ${transcriptionTime} ms
      `);

      // Broadcast user speech event
      if (conversationEventCallback) {
        conversationEventCallback('userSpeech', {
          originalTranscription,
          correctedTranscription,
          transcriptionTime,
          callSid,
        });
      }

      const aiResponseGenerationStartTime = Date.now();

      let response: string;

      // Check if user is in booking flow
      if (callSid && this.bookingFlowService.hasActiveBookingSession(callSid)) {
        this.logger.log(`📋 [BOOKING] Processing booking response for call: ${callSid}`);
        try {
          response = await this.bookingFlowService.processBookingResponse(callSid, correctedTranscription);
        } catch (bookingError) {
          this.logger.error(`❌ [BOOKING] Error in booking flow:`, bookingError);
          response =
            "I'm sorry, there was an issue with your booking. Please try again or press 1 to restart the booking process.";
        }
      } else {
        // Regular AI response flow
        response = await this.aiResponseService.generateResponse(
          correctedTranscription,
          assistantType,
          threadId,
          callSid,
          phoneNumber,
          originalTranscription,
        );
      }

      this.logger.verbose(`
        ✅ AI response generation took ${Date.now() - aiResponseGenerationStartTime} ms
      `);

      // Broadcast AI response event
      if (conversationEventCallback) {
        conversationEventCallback('aiResponse', {
          question: correctedTranscription,
          response,
          responseTime: Date.now() - aiResponseGenerationStartTime,
          callSid,
        });
      }

      await sendResponseToCaller(response);
      // chunkMap.clear(); // Clearing is handled in TwilioGateway after this call
    } catch (error) {
      this.logger.error('Error processing audio chunks:', error);

      // Broadcast error event
      if (conversationEventCallback) {
        conversationEventCallback('processingError', {
          error: error.message,
          callSid,
        });
      }

      // Potentially call sendResponseToCaller with an error message
      // await sendResponseToCaller("I'm sorry, I encountered an error processing your audio.");
    }
  }
}
