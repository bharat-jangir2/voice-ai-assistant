import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import * as fs from 'fs';
import * as path from 'path';
import { Server } from 'socket.io';
import { AudioProcessingService } from '../services/audio-processing.service';
import { SpeechService } from '../services/speech.service';
import { OpenAIAssistantService } from '../services/open-ai-assistant.service';
import { ConversationLoggerService } from '../services/conversation-logger.service';
import { BookingFlowService } from '../services/booking-flow.service';
import { BookingSessionService } from '../services/booking-session.service';
import { ChatGateway } from './chat.gateway';
import {
  MIN_ACTIVE_CHUNKS,
  MIN_CHUNKS,
  SILENCE_CHUNKS,
  SILENCE_THRESHOLD,
  INTERRUPT_THRESHOLD,
  INTERRUPT_CHUNK_COUNT,
  INTERRUPT_COOLDOWN_MS,
  PLAYBACK_BUFFER_MS,
} from '../utils/twilio.constants';
import { MediaMessage, TwilioStartEventPayload, StreamState } from '../interfaces/twilio.interfaces';
import { decodeMuLaw, getAverageAmplitude } from '../utils/twilio.utils';

@WebSocketGateway({
  cors: {
    origin: '*', // In production, replace with your specific origin
  },
})
export class TwilioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TwilioGateway.name);
  private readonly tempDir = path.join(process.cwd(), 'temp');
  private activeStreams: Map<string, StreamState> = new Map(); // Map streamSid to its state
  private pendingMediaQueues: Map<string, MediaMessage[]> = new Map(); // Queue for early media messages
  private assistantType: string;
  private readonly ragAssistantTypes = ['appraisee', 'hospital', 'prep-my-vehicle', 'speedel'];

  constructor(
    private readonly configService: ConfigService,
    private readonly speechService: SpeechService,
    private readonly audioProcessingService: AudioProcessingService,
    private readonly openAIAssistantService: OpenAIAssistantService,
    private readonly conversationLoggerService: ConversationLoggerService,
    private readonly bookingFlowService: BookingFlowService,
    private readonly bookingSessionService: BookingSessionService,
    private readonly chatGateway: ChatGateway,
  ) {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    this.assistantType = this.configService.get<string>('ASSISTANT_TYPE') || 'general';
  }

  handleConnection(client: any) {
    this.logger.debug('Twilio WebSocket connected.');

    // Handle incoming messages from Twilio
    client.on('message', async (TwilioWebSocketRawPayload: any) => {
      let TwilioWebSocketParsedPayload: any;
      try {
        TwilioWebSocketParsedPayload = JSON.parse(TwilioWebSocketRawPayload);
      } catch (err) {
        this.logger.error('Failed to parse incoming message:', err);
        return;
      }

      const streamSid = TwilioWebSocketParsedPayload.streamSid; // streamSid is usually at the top level of event messages

      try {
        if (TwilioWebSocketParsedPayload.event === 'connected') {
          this.logger.debug('WebSocket event "connected" received (ignoring as streamSid not yet known).');
        } else if (TwilioWebSocketParsedPayload.event === 'start') {
          const twilioStartEventPayload = TwilioWebSocketParsedPayload as TwilioStartEventPayload;

          // Access custom parameters from the start message
          const assistantType = twilioStartEventPayload.start.customParameters?.assistantType;
          const caller = twilioStartEventPayload.start.customParameters?.caller;

          this.logger.debug(
            `WebSocket event "start" received:\n` +
              `  streamSid: ${TwilioWebSocketParsedPayload.streamSid}\n` +
              `  callSid:   ${TwilioWebSocketParsedPayload.start.callSid}\n` +
              `  assistantType: ${assistantType}\n` +
              `  caller: ${caller}`,
          );

          // Store it for this stream
          this.assistantType = assistantType;

          // let threadId: string | undefined = undefined;

          // if (this.ragAssistantTypes.includes(this.assistantType)) {
          //   try {
          //     threadId = await this.openAIAssistantService.createNewThread();
          //     this.logger.log(`Created new RAG thread ${threadId} for stream ${streamSid}`);
          //   } catch (error) {
          //     this.logger.error(`Failed to create RAG thread for stream ${streamSid}:`, error);
          //   }
          // }

          const newStreamState: StreamState = {
            client,
            chunkMap: new Map<number, Buffer>(),
            currentCallSid: twilioStartEventPayload.start.callSid,
            isWelcomeMessagePlaying: false,
            lastMarkNameSent: null,
            isProcessingUserAudio: false,
            silenceChunkCount: 0,
            activeChunkCount: 0,
            //threadId: threadId,
            initialMediaChunks: [], // Initialize with an empty array

            // Interrupt functionality initialization
            isPlayingBack: false,
            playbackStartTime: 0,
            accumulatedAudioChunks: new Map<number, Buffer>(),
            interruptThreshold: INTERRUPT_THRESHOLD,
            interruptChunkCount: INTERRUPT_CHUNK_COUNT,
            consecutiveInterruptChunks: 0,
            lastInterruptTime: 0,
            playbackInterrupted: false,
          };
          this.activeStreams.set(streamSid, newStreamState);

          if (this.pendingMediaQueues.has(streamSid)) {
            this.logger.log(
              `Moving ${this.pendingMediaQueues.get(streamSid)!.length} pending media messages to initialMediaChunks for stream ${streamSid} after start.`,
            );
            newStreamState.initialMediaChunks = this.pendingMediaQueues.get(streamSid)!;
            this.pendingMediaQueues.delete(streamSid);
          }

          await this.handleStartMessage(twilioStartEventPayload, streamSid);
        } else if (TwilioWebSocketParsedPayload.event === 'media') {
          if (streamSid && this.activeStreams.has(streamSid)) {
            const streamState = this.activeStreams.get(streamSid)!;
            // Your existing log for active media:
            // this.logger.log(`WebSocket event "media" received for stream: ${streamSid}`);
            await this.handleWebSocketMessage(TwilioWebSocketParsedPayload, streamState, streamSid);
          } else if (streamSid) {
            this.logger.log(`Queueing "media" event for stream ${streamSid} (stream not yet active).`);
            if (!this.pendingMediaQueues.has(streamSid)) {
              this.pendingMediaQueues.set(streamSid, []);
            }
            this.pendingMediaQueues.get(streamSid)!.push(TwilioWebSocketParsedPayload as MediaMessage);
          } else {
            this.logger.warn(
              'Received "media" event with NO streamSid. Full message:',
              JSON.stringify(TwilioWebSocketParsedPayload),
            );
          }
        } else if (TwilioWebSocketParsedPayload.event === 'stop') {
          this.logger.log(
            `WebSocket event "stop" received for stream: ${TwilioWebSocketParsedPayload.stop.streamSid}. CallSid: ${TwilioWebSocketParsedPayload.stop.callSid}`,
          );

          // Clean up booking session when call ends
          if (TwilioWebSocketParsedPayload.stop.callSid) {
            this.bookingFlowService.clearBookingSession(TwilioWebSocketParsedPayload.stop.callSid);
          }

          if (this.activeStreams.has(TwilioWebSocketParsedPayload.stop.streamSid)) {
            this.activeStreams.delete(TwilioWebSocketParsedPayload.stop.streamSid);
            this.logger.log(`Stream ${TwilioWebSocketParsedPayload.stop.streamSid} removed from active streams.`);
          }
          if (this.pendingMediaQueues.has(TwilioWebSocketParsedPayload.stop.streamSid)) {
            this.logger.log(`Clearing pending media queue for stopped stream ${TwilioWebSocketParsedPayload.stop.streamSid}`);
            this.pendingMediaQueues.delete(TwilioWebSocketParsedPayload.stop.streamSid);
          }
        } else if (TwilioWebSocketParsedPayload.event === 'dtmf') {
          this.logger.log(
            `DTMF received on stream ${streamSid}: ${TwilioWebSocketParsedPayload.dtmf.digit}, track=${TwilioWebSocketParsedPayload.dtmf.track}`,
          );

          // Handle dialpad "1" for booking
          this.logger.log(`🔍 [DEBUG] Full DTMF payload:`, JSON.stringify(TwilioWebSocketParsedPayload.dtmf, null, 2));

          // Try different ways to access DTMF digits
          const dtmfDigits =
            TwilioWebSocketParsedPayload.dtmf?.digits ||
            TwilioWebSocketParsedPayload.dtmf?.digit ||
            TwilioWebSocketParsedPayload.dtmf;

          this.logger.log(`🔍 [DEBUG] DTMF digits extracted: "${dtmfDigits}" (type: ${typeof dtmfDigits})`);

          if (dtmfDigits === '1' || dtmfDigits === 1) {
            this.logger.log(`📋 [BOOKING] DTMF "1" detected! Starting booking flow...`);
            await this.handleBookingRequest(streamSid);
          } else if (dtmfDigits === '4' || dtmfDigits === 4) {
            this.logger.log(`✅ [BOOKING] DTMF "4" detected! Confirming answer...`);
            await this.handleBookingConfirmation(streamSid, '4');
          } else if (dtmfDigits === '5' || dtmfDigits === 5) {
            this.logger.log(`❌ [BOOKING] DTMF "5" detected! Rejecting answer...`);
            await this.handleBookingConfirmation(streamSid, '5');
          } else {
            this.logger.log(`❌ [DEBUG] DTMF "${dtmfDigits}" does not match expected values (1, 4, 5)`);
          }
        } else if (TwilioWebSocketParsedPayload.event === 'mark') {
          this.logger.verbose(`
        📥 WebSocket Event Received: "mark"
            Stream SID : ${streamSid}
            Mark Name  : ${TwilioWebSocketParsedPayload.mark.name}
          `);

          if (streamSid && this.activeStreams.has(streamSid)) {
            const streamState = this.activeStreams.get(streamSid)!;
            await this.handleWebSocketMessage(TwilioWebSocketParsedPayload, streamState, streamSid);
          }
        } else {
          this.logger.debug(`Unhandled WebSocket event: ${TwilioWebSocketParsedPayload.event}`);
        }
      } catch (error) {
        this.logger.error(`Error handling WebSocket message for stream ${streamSid}:`, error);
      }
    });

    // Handle client disconnect
    client.on('disconnect', () => {
      this.logger.log('Socket.IO client disconnected');

      // Find all streams associated with this client and end their sessions
      for (const [streamSid, streamState] of this.activeStreams.entries()) {
        if (streamState.client === client) {
          this.logger.log(`Ending session for stream ${streamSid} due to Socket.IO disconnect`);

          // End the conversation session and send email
          if (streamState.currentCallSid) {
            this.conversationLoggerService
              .endSession(streamState.currentCallSid)
              .then(() => {
                this.logger.log(`Successfully ended session ${streamState.currentCallSid} and sent email`);
              })
              .catch((error) => {
                this.logger.error(`Failed to end session ${streamState.currentCallSid}:`, error);
              });
          }

          // Remove the stream from active streams
          this.activeStreams.delete(streamSid);
        }
      }
    });
  }

  private async handleWebSocketMessage(msg: any, streamState: StreamState, streamSid: string) {
    switch (msg.event) {
      // 'start' is handled above to initialize streamState
      case 'media':
        await this.handleMediaMessage(msg as MediaMessage, streamState, streamSid);
        break;
      case 'dtmf':
        this.logger.log(`DTMF received on stream ${streamSid}: ${msg.dtmf.digit}, track=${msg.dtmf.track}`);

        // Handle dialpad "1" for booking
        this.logger.log(`🔍 [DEBUG] Full DTMF payload:`, JSON.stringify(msg.dtmf, null, 2));

        // Try different ways to access DTMF digits
        const dtmfDigits = msg.dtmf?.digits || msg.dtmf?.digit || msg.dtmf;

        this.logger.log(`🔍 [DEBUG] DTMF digits extracted: "${dtmfDigits}" (type: ${typeof dtmfDigits})`);

        if (dtmfDigits === '1' || dtmfDigits === 1) {
          this.logger.log(`📋 [BOOKING] DTMF "1" detected! Starting booking flow...`);
          await this.handleBookingRequest(streamSid);
        } else if (dtmfDigits === '4' || dtmfDigits === 4) {
          this.logger.log(`✅ [BOOKING] DTMF "4" detected! Confirming answer...`);
          await this.handleBookingConfirmation(streamSid, '4');
        } else if (dtmfDigits === '5' || dtmfDigits === 5) {
          this.logger.log(`❌ [BOOKING] DTMF "5" detected! Rejecting answer...`);
          await this.handleBookingConfirmation(streamSid, '5');
        } else {
          this.logger.log(`❌ [DEBUG] DTMF "${dtmfDigits}" does not match expected values (1, 4, 5)`);
        }
        break;
      case 'mark':
        this.logger.verbose(`
        📥 WebSocket Event Received: "mark"
            Stream SID : ${streamSid}
            Mark Name  : ${msg.mark.name}
          `);

        if (streamState.isWelcomeMessagePlaying && msg.mark.name === streamState.lastMarkNameSent) {
          streamState.isWelcomeMessagePlaying = false;
          streamState.lastMarkNameSent = null; // Clear the last mark for welcome

          // Process any initial media chunks that were queued before welcome message finished
          if (streamState.initialMediaChunks && streamState.initialMediaChunks.length > 0) {
            this.logger.log(
              `Processing ${streamState.initialMediaChunks.length} initial media chunks for stream ${streamSid} after welcome.`,
            );
            for (const mediaMsg of streamState.initialMediaChunks) {
              // Now process these chunks. isWelcomeMessagePlaying is false.
              await this.handleMediaMessage(mediaMsg, streamState, streamSid);
            }
            streamState.initialMediaChunks = []; // Clear after processing
          }
          this.logger.log(`Stream ${streamSid} is now ready for user audio.`);
          // Now ready to process user speech normally
        } else if (streamState.isPlayingBack && msg.mark.name === streamState.lastMarkNameSent) {
          this.logger.log(`AI response playback completed for stream ${streamSid}. Resuming audio collection.`);
          streamState.isPlayingBack = false;
          streamState.isProcessingUserAudio = false;
          streamState.lastMarkNameSent = null;
          streamState.playbackInterrupted = false;

          // Process any accumulated audio if playback was interrupted
          if (streamState.accumulatedAudioChunks.size > 0) {
            this.logger.log(
              `Processing ${streamState.accumulatedAudioChunks.size} accumulated audio chunks after playback completion on stream ${streamSid}`,
            );
            await this.processAccumulatedAudio(streamState, streamSid);
          }
        }
        break;
      // 'stop' is handled above to clear streamState
      default:
        this.logger.warn(`Unknown event received on stream ${streamSid}: ${msg.event}`);
    }
  }

  private async getAssistantFriendlyNameForWelcome(): Promise<string> {
    let friendlyName = 'AI'; // A more generic default

    if (this.assistantType === 'general') {
      friendlyName = 'General AI';
    } else if (this.assistantType && this.assistantType.length > 0) {
      // Title case the assistantType (e.g., "appraisee" -> "Appraisee")
      friendlyName = this.assistantType.charAt(0).toUpperCase() + this.assistantType.slice(1);
    }
    return friendlyName;
  }

  private async handleStartMessage(twilioStartEventPayload: TwilioStartEventPayload, streamSid: string) {
    const streamState = this.activeStreams.get(streamSid);
    if (streamState) {
      const assistantNamePart = await this.getAssistantFriendlyNameForWelcome();
      const welcomeText = `Hello, I am your ${assistantNamePart} assistant. How can I help you today? If you'd like to make a booking, please press 1 on your keypad.`;
      await this.playWelcomeMessage(streamSid, welcomeText);
      streamState.isWelcomeMessagePlaying = true;

      // Broadcast call start event to Socket.IO clients
      this.chatGateway.broadcastConversationEvent(streamState.currentCallSid, 'callStarted', {
        callSid: streamState.currentCallSid,
        assistantType: this.assistantType,
        welcomeMessage: welcomeText,
        streamSid: streamSid,
      });

      console.log('🚀 ~ handleStartMessage ~ callStarted event sent to chatGateway');
    }
  }

  private async playWelcomeMessage(streamSid: string, text: string) {
    const streamState = this.activeStreams.get(streamSid);
    if (!streamState || !streamState.client) {
      this.logger.error(`Cannot play welcome message: stream ${streamSid} not found or client missing.`);
      return;
    }

    this.logger.verbose(`
        ✅ Playing Welcome Message
           Stream SID : ${streamSid}
           Message    : "${text}"
      `);

    try {
      const muLawBuffer: Buffer = await this.speechService.createAudioFileFromText(text);
      const CHUNK_SIZE = 160; // For mu-law 8000 Hz audio
      const markName = `welcome_msg_end_${Date.now()}`;
      streamState.lastMarkNameSent = markName;

      // Send the welcome message in chunks
      for (let i = 0; i < muLawBuffer.length; i += CHUNK_SIZE) {
        // Check if playback was interrupted during the loop
        if (streamState.playbackInterrupted) {
          this.logger.log(`Playback was interrupted during sending, stopping audio chunks on stream ${streamSid}`);
          break;
        }

        let chunk = muLawBuffer.slice(i, i + CHUNK_SIZE);

        const mediaMessage = {
          event: 'media',
          streamSid: streamSid,
          media: {
            payload: chunk.toString('base64'),
            track: 'outbound_track',
            chunk: (i / CHUNK_SIZE + 1).toString(),
            timestamp: Date.now().toString(),
          },
        };
        streamState.client.send(JSON.stringify(mediaMessage));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Only send the end mark if playback wasn't interrupted
      if (!streamState.playbackInterrupted) {
        const markMessage = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: markName },
        };
        streamState.client.send(JSON.stringify(markMessage));
        // this.logger.log(`Sent mark '${markName}' for AI response on stream ${streamSid}`);
      }
    } catch (error) {
      this.logger.error(`Error playing welcome message on stream ${streamSid}:`, error);
      if (streamState) {
        streamState.isWelcomeMessagePlaying = false; // Reset flag on error
      }
    }
  }

  private async handleMediaMessage(msg: MediaMessage, streamState: StreamState, streamSid: string) {
    const seq = parseInt(msg.sequenceNumber, 10);
    const audioChunk = Buffer.from(msg.media.payload, 'base64');
    const pcmArray = decodeMuLaw(audioChunk);
    const avgAmplitude = getAverageAmplitude(pcmArray);
    const currentTime = Date.now();

    // Handle welcome message state
    if (streamState.isWelcomeMessagePlaying) {
      // Queue audio chunks during welcome message
      if (!streamState.initialMediaChunks) {
        streamState.initialMediaChunks = [];
      }
      streamState.initialMediaChunks.push(msg);
      return;
    }

    // Handle interrupt detection during playback
    if (streamState.isPlayingBack) {
      await this.handleInterruptDetection(msg, streamState, streamSid, avgAmplitude, currentTime);
      return;
    }

    // Normal audio processing (not during playback)
    await this.handleNormalAudioProcessing(msg, streamState, streamSid, avgAmplitude, seq);
  }

  private async handleInterruptDetection(
    msg: MediaMessage,
    streamState: StreamState,
    streamSid: string,
    avgAmplitude: number,
    currentTime: number,
  ) {
    const seq = parseInt(msg.sequenceNumber, 10);
    const audioChunk = Buffer.from(msg.media.payload, 'base64');

    // Check if enough time has passed since playback started to avoid false interrupts
    if (currentTime - streamState.playbackStartTime < PLAYBACK_BUFFER_MS) {
      return;
    }

    // Check cooldown period to prevent rapid interrupts
    if (currentTime - streamState.lastInterruptTime < INTERRUPT_COOLDOWN_MS) {
      return;
    }

    // Detect interrupt based on amplitude threshold
    if (avgAmplitude > streamState.interruptThreshold) {
      streamState.consecutiveInterruptChunks++;

      if (streamState.consecutiveInterruptChunks >= streamState.interruptChunkCount) {
        // Interrupt detected!
        this.logger.log(`🚨 INTERRUPT DETECTED on stream ${streamSid}! User started speaking during playback.`);

        // Stop playback by sending a stop mark
        await this.stopPlayback(streamState, streamSid);

        // Accumulate this audio chunk
        streamState.accumulatedAudioChunks.set(seq, audioChunk);

        // Reset interrupt counters
        streamState.consecutiveInterruptChunks = 0;
        streamState.lastInterruptTime = currentTime;
        streamState.playbackInterrupted = true;

        // Start normal audio processing
        streamState.isPlayingBack = false;
        streamState.isProcessingUserAudio = false;
        streamState.silenceChunkCount = 0;
        streamState.activeChunkCount = 0;
      }
    } else {
      // Reset consecutive interrupt count if amplitude drops
      streamState.consecutiveInterruptChunks = 0;
    }

    // Always accumulate audio during playback for potential processing later
    streamState.accumulatedAudioChunks.set(seq, audioChunk);
  }

  private async handleNormalAudioProcessing(
    msg: MediaMessage,
    streamState: StreamState,
    streamSid: string,
    avgAmplitude: number,
    seq: number,
  ) {
    const audioChunk = Buffer.from(msg.media.payload, 'base64');

    // Only process if not currently processing user audio
    if (streamState.isProcessingUserAudio) {
      return;
    }

    streamState.chunkMap.set(seq, audioChunk);

    // Reset silence detection state if this is the first chunk after welcome message
    if (streamState.initialMediaChunks && streamState.initialMediaChunks.length > 0) {
      streamState.silenceChunkCount = 0;
      streamState.activeChunkCount = 0;
      streamState.initialMediaChunks = []; // Clear the initial chunks array
    }

    // Update silence detection counters
    if (avgAmplitude > SILENCE_THRESHOLD) {
      streamState.silenceChunkCount = 0;
      streamState.activeChunkCount++;
    } else {
      streamState.silenceChunkCount++;
    }

    // Add debug logging to understand the timing
    if (streamState.chunkMap.size % 10 === 0) {
      // Log every 10 chunks
      this.logger.debug(
        `Audio processing state: ` +
          `chunks=${streamState.chunkMap.size}, ` +
          `active=${streamState.activeChunkCount}, ` +
          `silence=${streamState.silenceChunkCount}, ` +
          `amplitude=${avgAmplitude}`,
      );
    }

    // Check if we should process the audio
    const shouldProcess =
      streamState.silenceChunkCount >= SILENCE_CHUNKS &&
      streamState.activeChunkCount >= MIN_ACTIVE_CHUNKS &&
      streamState.chunkMap.size >= MIN_CHUNKS;

    if (shouldProcess) {
      this.logger.verbose(`
        ✅ Finalizing audio processing: 
           Chunks: ${streamState.chunkMap.size} (${(streamState.chunkMap.size * 40).toFixed(0)}ms)
           Active: ${streamState.activeChunkCount} (${(streamState.activeChunkCount * 40).toFixed(0)}ms)
           Silence: ${streamState.silenceChunkCount} (${(streamState.silenceChunkCount * 40).toFixed(0)}ms)
      `);

      streamState.isProcessingUserAudio = true;

      // Combine accumulated audio with current audio if we have accumulated audio from an interrupt
      let chunksToProcess: Map<number, Buffer>;
      if (streamState.accumulatedAudioChunks.size > 0) {
        this.logger.log(
          `Combining ${streamState.accumulatedAudioChunks.size} accumulated chunks with ${streamState.chunkMap.size} new chunks on stream ${streamSid}`,
        );
        chunksToProcess = this.combineAudioChunks(streamState.accumulatedAudioChunks, streamState.chunkMap);
        streamState.accumulatedAudioChunks.clear();
      } else {
        chunksToProcess = new Map(streamState.chunkMap);
      }

      streamState.chunkMap.clear();
      streamState.silenceChunkCount = 0;
      streamState.activeChunkCount = 0;

      try {
        await this.audioProcessingService.processAudioChunks(
          this.assistantType as string,
          chunksToProcess,
          async (response: string) => {
            await this.sendResponseToCaller(response, streamSid);
            streamState.silenceChunkCount = 0;
            streamState.activeChunkCount = 0;
          },
          streamState.threadId,
          streamState.currentCallSid,
          this.getPhoneNumberFromStream(streamSid),
          // Conversation event callback for Socket.IO broadcasting
          (eventType: string, data: any) => {
            this.chatGateway.broadcastConversationEvent(streamState.currentCallSid, eventType, data);
          },
        );
      } catch (error) {
        this.logger.error(`Error during audioProcessingService.processAudioChunks for stream ${streamSid}:`, error);
      } finally {
        // ✅ Always reset processing state, regardless of success or failure
        streamState.isProcessingUserAudio = false;
        streamState.silenceChunkCount = 0;
        streamState.activeChunkCount = 0;
      }
    }
  }

  private async stopPlayback(streamState: StreamState, streamSid: string) {
    try {
      // Send a stop mark to interrupt the current playback
      const stopMarkName = `stop_playback_${Date.now()}`;
      const stopMarkMessage = {
        event: 'mark',
        streamSid: streamSid,
        mark: { name: stopMarkName },
      };

      streamState.client.send(JSON.stringify(stopMarkMessage));
      this.logger.log(`Sent stop mark '${stopMarkName}' to interrupt playback on stream ${streamSid}`);
    } catch (error) {
      this.logger.error(`Error stopping playback on stream ${streamSid}:`, error);
    }
  }

  /**
   * Handles booking request when user presses "1"
   */
  private async handleBookingRequest(streamSid: string): Promise<void> {
    this.logger.log(`🚀 [BOOKING] handleBookingRequest called for streamSid: ${streamSid}`);

    const streamState = this.activeStreams.get(streamSid);
    if (!streamState) {
      this.logger.error(`❌ [BOOKING] No stream state found for stream ${streamSid}`);
      return;
    }

    const callSid = streamState.currentCallSid;
    this.logger.log(`📋 [BOOKING] User pressed 1 for booking on call: ${callSid}`);

    try {
      // Stop any current playback
      this.logger.log(`🛑 [BOOKING] Stopping current playback...`);
      await this.stopPlayback(streamState, streamSid);

      // Start booking flow
      this.logger.log(`🚀 [BOOKING] Starting booking flow...`);
      const bookingMessage = this.bookingFlowService.startBookingFlow(callSid);
      this.logger.log(`📝 [BOOKING] Booking message generated: "${bookingMessage}"`);

      // Send booking message to caller
      this.logger.log(`📞 [BOOKING] Sending booking message to caller...`);
      await this.sendResponseToCaller(bookingMessage, streamSid);
      this.logger.log(`✅ [BOOKING] Booking flow initiated successfully`);
    } catch (error) {
      this.logger.error(`❌ [BOOKING] Error in handleBookingRequest:`, error);
    }
  }

  /**
   * Handles booking confirmation when user presses "4" or "5"
   */
  private async handleBookingConfirmation(streamSid: string, confirmation: string): Promise<void> {
    this.logger.log(`🔔 [BOOKING] handleBookingConfirmation called for streamSid: ${streamSid}, confirmation: ${confirmation}`);

    const streamState = this.activeStreams.get(streamSid);
    if (!streamState) {
      this.logger.error(`❌ [BOOKING] No stream state found for stream ${streamSid}`);
      return;
    }

    const callSid = streamState.currentCallSid;
    this.logger.log(`📋 [BOOKING] User pressed ${confirmation} for confirmation on call: ${callSid}`);

    try {
      // Stop current playback
      this.logger.log(`🛑 [BOOKING] Stopping current playback...`);
      await this.stopPlayback(streamState, streamSid);

      // Process confirmation
      this.logger.log(`🔄 [BOOKING] Processing confirmation...`);
      const confirmationMessage = await this.bookingFlowService.processBookingResponse(callSid, confirmation);
      this.logger.log(`📝 [BOOKING] Confirmation message generated: "${confirmationMessage}"`);

      // Send confirmation message to caller
      this.logger.log(`📞 [BOOKING] Sending confirmation message to caller...`);
      await this.sendResponseToCaller(confirmationMessage, streamSid);

      this.logger.log(`✅ [BOOKING] Confirmation processed successfully`);
    } catch (error) {
      this.logger.error(`❌ [BOOKING] Error in handleBookingConfirmation:`, error);
    }
  }

  private getPhoneNumberFromStream(streamSid: string): string | undefined {
    // You might want to store phone number in StreamState or get it from Twilio
    // For now, return undefined
    return undefined;
  }

  private async sendResponseToCaller(response: string, streamSid: string) {
    const streamState = this.activeStreams.get(streamSid);
    if (!streamState || !streamState.client) {
      this.logger.error(`Cannot send response: stream ${streamSid} not found or client missing.`);
      return;
    }

    // Check if we're currently playing back audio and need to stop it first
    if (streamState.isPlayingBack) {
      this.logger.log(`Stopping current playback before sending new response on stream ${streamSid}`);
      await this.stopPlayback(streamState, streamSid);

      // Wait a bit for the stop mark to take effect
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reset playback state
      streamState.isPlayingBack = false;
      streamState.playbackInterrupted = true;
    }

    // this.logger.log(`Sending AI response to stream ${streamSid}`);
    try {
      const textToSpeechStartTime = Date.now();
      const muLawBuffer: Buffer = await this.speechService.createAudioFileFromText(response);
      this.logger.verbose(`
        ✅ Text-to-speech (TTS): ${this.speechService.getTTSProvider()}
           Time taken: ${Date.now() - textToSpeechStartTime} ms
      `);

      const CHUNK_SIZE = 160;
      const markName = `ai_response_end_${Date.now()}`;
      streamState.lastMarkNameSent = markName;

      // Set playback state
      streamState.isPlayingBack = true;
      streamState.playbackStartTime = Date.now();
      streamState.playbackInterrupted = false;
      streamState.accumulatedAudioChunks.clear(); // Clear any previous accumulated audio

      // Send the AI response in chunks
      for (let i = 0; i < muLawBuffer.length; i += CHUNK_SIZE) {
        // Check if playback was interrupted during the loop
        if (streamState.playbackInterrupted) {
          this.logger.log(`Playback was interrupted during sending, stopping audio chunks on stream ${streamSid}`);
          break;
        }

        let chunk = muLawBuffer.slice(i, i + CHUNK_SIZE);

        const mediaMessage = {
          event: 'media',
          streamSid: streamSid,
          media: {
            payload: chunk.toString('base64'),
            track: 'outbound_track',
            chunk: (i / CHUNK_SIZE + 1).toString(),
            timestamp: Date.now().toString(),
          },
        };
        streamState.client.send(JSON.stringify(mediaMessage));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Only send the end mark if playback wasn't interrupted
      if (!streamState.playbackInterrupted) {
        const markMessage = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: markName },
        };
        streamState.client.send(JSON.stringify(markMessage));
        // this.logger.log(`Sent mark '${markName}' for AI response on stream ${streamSid}`);
      }
    } catch (error) {
      this.logger.error(`Error sending AI response to stream ${streamSid}:`, error);
      if (streamState) {
        streamState.isPlayingBack = false;
        streamState.isProcessingUserAudio = false;
        streamState.lastMarkNameSent = null;
      }
    }
  }

  private async processAccumulatedAudio(streamState: StreamState, streamSid: string) {
    try {
      const accumulatedChunks = new Map(streamState.accumulatedAudioChunks);
      streamState.accumulatedAudioChunks.clear();

      // Process the accumulated audio
      await this.audioProcessingService.processAudioChunks(
        this.assistantType as string,
        accumulatedChunks,
        async (response: string) => {
          await this.sendResponseToCaller(response, streamSid);
          streamState.silenceChunkCount = 0;
          streamState.activeChunkCount = 0;
        },
        streamState.threadId,
        streamState.currentCallSid,
        this.getPhoneNumberFromStream(streamSid),
        // Conversation event callback for Socket.IO broadcasting
        (eventType: string, data: any) => {
          this.chatGateway.broadcastConversationEvent(streamState.currentCallSid, eventType, data);
        },
      );
    } catch (error) {
      this.logger.error(`Error processing accumulated audio for stream ${streamSid}:`, error);
    }
  }

  private combineAudioChunks(accumulatedChunks: Map<number, Buffer>, newChunks: Map<number, Buffer>): Map<number, Buffer> {
    const combinedChunks = new Map<number, Buffer>();

    // Add accumulated chunks first
    for (const [seq, chunk] of accumulatedChunks) {
      combinedChunks.set(seq, chunk);
    }

    // Add new chunks, potentially overwriting if sequence numbers overlap
    for (const [seq, chunk] of newChunks) {
      combinedChunks.set(seq, chunk);
    }

    return combinedChunks;
  }

  handleDisconnect(client: any) {
    this.logger.debug(`Twilio WebSocket disconnected (raw WebSocket disconnect)`);

    // Find all streams associated with this client and end their sessions
    for (const [streamSid, streamState] of this.activeStreams.entries()) {
      if (streamState.client === client) {
        this.logger.log(`Ending session for stream ${streamSid} due to WebSocket disconnect`);

        // Broadcast call end event to Socket.IO clients
        if (streamState.currentCallSid) {
          this.chatGateway.broadcastConversationEvent(streamState.currentCallSid, 'callEnded', {
            callSid: streamState.currentCallSid,
            streamSid: streamSid,
            reason: 'WebSocket disconnect',
          });
        }

        // End the conversation session and send email
        if (streamState.currentCallSid) {
          this.conversationLoggerService
            .endSession(streamState.currentCallSid)
            .then(() => {
              this.logger.log(`Successfully ended session ${streamState.currentCallSid} and sent email`);
            })
            .catch((error) => {
              this.logger.error(`Failed to end session ${streamState.currentCallSid}:`, error);
            });
        }

        // Remove the stream from active streams
        this.activeStreams.delete(streamSid);
      }
    }
  }
}
