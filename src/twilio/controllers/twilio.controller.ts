import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { getAssistantTypeByPhoneNumber } from 'src/config/phone-assistant-mapping';
import * as twilio from 'twilio';
import { EndCallDto, MakeCallDto, QuestionDto } from '../interfaces/twilio.interfaces';
import { QdrantDBService } from '../services/qdrant-db.services';
import { RedisService } from '../services/redis.service';
import { TwilioApiService } from '../services/twilio-api.service';
import { DirectAIService } from '../services/direct-ai.service';

@Controller('voice')
export class TwilioController {
  constructor(
    private readonly twilioApiService: TwilioApiService,
    private readonly qdrantDBService: QdrantDBService,
    private readonly redisService: RedisService,
    private readonly directAIService: DirectAIService,
  ) {}

  // Handles incoming Twilio calls and generates TwiML with WebSocket stream configuration
  @Post('incoming')
  handleIncomingCall(@Body() body: any): string {
    const twiml = new twilio.twiml.VoiceResponse();

    // Extract the called number (the number that received the call)
    const calledNumber = body.Called || body.To; // Use Called or To field

    // Get assistant type based on the called number
    const assistantType = getAssistantTypeByPhoneNumber(calledNumber);

    const connect = twiml.connect();
    const stream = connect.stream({
      url: process.env.WEBSOCKET_URL!,
    });

    stream.parameter({
      name: 'assistantType',
      value: assistantType,
    });

    stream.parameter({
      name: 'caller',
      value: calledNumber || 'unknown',
    });

    return twiml.toString() as string;
  }

  // Initiates an outbound call to the specified phone number
  @Post('make-call')
  @HttpCode(HttpStatus.OK)
  async makeCallApi(@Body() makeCallDto: MakeCallDto): Promise<{ callSid: string; message: string }> {
    if (!makeCallDto.toPhoneNumber) {
      throw new BadRequestException('toPhoneNumber is required');
    }
    const result = await this.twilioApiService.makeCall(makeCallDto.toPhoneNumber);
    return { callSid: result.callSid, message: 'Call initiated successfully' };
  }

  // Ends an active call using the provided call SID
  @Post('end-call')
  @HttpCode(HttpStatus.OK)
  async endCallApi(@Body() endCallDto: EndCallDto): Promise<{ callSid: string; status: string; message: string }> {
    if (!endCallDto.callSid) {
      throw new BadRequestException('callSid is required');
    }
    const result = await this.twilioApiService.endCall(endCallDto.callSid);
    return { callSid: result.callSid, status: result.status, message: 'Call status updated successfully' };
  }

  // Get answer for a question using direct AI response (bypassing database)
  @Post('question')
  @HttpCode(HttpStatus.OK)
  async getAnswerApi(@Body() questionDto: QuestionDto): Promise<any> {
    if (!questionDto.question) {
      throw new BadRequestException('question is required');
    }

    const assistantType = questionDto.assistantType || 'general';
    const sessionId = questionDto.sessionId || `api-${Date.now()}`;
    const phoneNumber = questionDto.phoneNumber || 'api-call';

    console.log(`🔍 [QUESTION API] Request received:`);
    console.log(`   Question: "${questionDto.question}"`);
    console.log(`   Assistant Type: ${assistantType}`);
    console.log(`   Session ID: ${sessionId}`);
    console.log(`   Phone Number: ${phoneNumber}`);

    // KEEP: Session management for conversation history
    // Create or get conversation session
    const session = this.qdrantDBService['conversationLogger'].getOrCreateSession(sessionId, assistantType, phoneNumber);

    // Create interaction for this Q&A
    const interaction = this.qdrantDBService['conversationLogger'].createInteraction(questionDto.question, false);

    try {
      // COMMENTED OUT: Redis lookup
      // First, try to get answer from Redis (same as voice interaction)
      // const redisAnswer = await this.redisService.getAnswerFromRedis(questionDto.question, assistantType);
      // if (redisAnswer) {
      //   // Update interaction with Redis response
      //   this.qdrantDBService['conversationLogger'].updateAnswer(interaction, redisAnswer);
      //   this.qdrantDBService['conversationLogger'].updateSourceRedis(interaction);

      //   // Add interaction to session
      //   await this.qdrantDBService['conversationLogger'].addInteraction(session.sessionId, interaction);

      //   return {
      //     sessionId,
      //     question: questionDto.question,
      //     correction: interaction.correction,
      //     source: interaction.source,
      //     answer: redisAnswer,
      //     timestamp: interaction.timestamp,
      //   };
      // }

      // COMMENTED OUT: Qdrant RAG process
      // If Redis doesn't have the answer, use Qdrant RAG (same as voice interaction)
      // const answer = await this.qdrantDBService.getAnswerUsingQdrantRAG(
      //   questionDto.question,
      //   assistantType,
      //   sessionId,
      //   undefined, // confidence
      //   phoneNumber,
      // );

      // Get the updated interaction data
      // const updatedSession = await this.qdrantDBService['conversationLogger'].getSession(sessionId);
      // const lastInteraction = updatedSession?.interactions[updatedSession.interactions.length - 1];

      // return {
      //   sessionId,
      //   question: questionDto.question,
      //   correction: lastInteraction?.correction,
      //   source: lastInteraction?.source,
      //   answer,
      //   timestamp: lastInteraction?.timestamp,
      // };

      // NEW: Direct AI response using DirectAIService with conversation context
      const answer = await this.directAIService.getDirectAIResponse(questionDto.question, assistantType, sessionId);

      // KEEP: Update interaction with response for session tracking
      this.qdrantDBService['conversationLogger'].updateAnswer(interaction, answer);
      this.qdrantDBService['conversationLogger'].updateSourceDirectAI(interaction);

      // KEEP: Add interaction to session for conversation history
      await this.qdrantDBService['conversationLogger'].addInteraction(session.sessionId, interaction);

      // NEW: For Question API, we can end the session after each request
      // This ensures conversation logs are cleaned up immediately after email is sent
      // If you want to maintain conversation history across multiple Question API calls,
      // comment out the line below and sessions will persist until manually cleaned
      await this.qdrantDBService['conversationLogger'].endSession(sessionId);

      return {
        sessionId,
        question: questionDto.question,
        answer,
        source: 'direct-ai',
        timestamp: new Date().toISOString(),
        note: 'Response generated directly from AI without database lookup',
      };
    } catch (error) {
      // KEEP: Error handling for session tracking
      this.qdrantDBService['conversationLogger'].updateError(interaction, error.message);
      throw new BadRequestException(`Failed to generate AI response: ${error.message}`);
    }
  }
}
