import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

export class ChatGateway {
  private readonly logger = new Logger(ChatGateway.name);

  // Map callSid to socket connections for real-time streaming
  private callSidToSocketMap: Map<string, Socket[]> = new Map();

  // Store recent events for late registrations (last 5 minutes)
  private recentEvents: Map<string, Array<{ eventType: string; data: any; timestamp: string }>> = new Map();
  private readonly EVENT_RETENTION_MS = 5 * 60 * 1000; // 5 minutes

  // Initialize Socket.IO handlers
  initialize(io: Server) {
    io.on('connection', (client: Socket) => {
      this.logger.log(`🚀 [SOCKET] Client connected: ${client.id}`);

      // Handle callSid registration from client (for voice calls)
      client.on('registerCall', (data: { callSid: string }) => {
        console.log('🚀 ~ :17 ~ ChatGateway ~ initialize ~ data:', data);
        const { callSid } = data;
        this.registerCallSid(callSid, client);
        this.logger.log(`🚀 [SOCKET] CallSid ${callSid} registered with socket ${client.id}`);

        // Replay recent events for this callSid
        this.replayRecentEvents(callSid, client);

        // Confirm registration to client
        client.emit('callRegistered', { callSid, success: true });
      });

      // Handle chat session registration from client (for chat)
      client.on('registerChat', (data: { sessionId: string }) => {
        this.logger.log(`🚀 [SOCKET] Chat session registration request:`, data);
        const { sessionId } = data;
        this.registerCallSid(sessionId, client); // Reuse the same mapping for chat sessions
        this.logger.log(`🚀 [SOCKET] Chat session ${sessionId} registered with socket ${client.id}`);

        // Replay recent events for this session
        this.replayRecentEvents(sessionId, client);

        // Confirm registration to client
        client.emit('chatRegistered', { sessionId, success: true });
      });

      // Handle callSid unregistration
      client.on('unregisterCall', (data: { callSid: string }) => {
        const { callSid } = data;
        this.unregisterCallSid(callSid, client);
        this.logger.log(`🚀 [SOCKET] CallSid ${callSid} unregistered from socket ${client.id}`);
      });

      // Handle chat session unregistration
      client.on('unregisterChat', (data: { sessionId: string }) => {
        const { sessionId } = data;
        this.unregisterCallSid(sessionId, client);
        this.logger.log(`🚀 [SOCKET] Chat session ${sessionId} unregistered from socket ${client.id}`);
      });

      // Handle typing indicators for chat
      client.on('typing', (data: { sessionId: string; isTyping: boolean; userId?: string }) => {
        this.logger.log(`🚀 [SOCKET] Typing indicator:`, data);
        this.broadcastConversationEvent(data.sessionId, 'typing', {
          isTyping: data.isTyping,
          userId: data.userId,
          timestamp: new Date().toISOString(),
        });
      });

      // Handle disconnect
      client.on('disconnect', () => {
        this.logger.log(`🚀 [SOCKET] Client disconnected: ${client.id}`);

        // Clean up callSid mappings for this socket
        this.cleanupSocketFromCallMappings(client);
      });
    });
  }

  // Register a callSid with a socket connection
  private registerCallSid(callSid: string, socket: Socket) {
    if (!this.callSidToSocketMap.has(callSid)) {
      this.callSidToSocketMap.set(callSid, []);
    }
    this.callSidToSocketMap.get(callSid)!.push(socket);
  }

  // Unregister a callSid from a socket connection
  private unregisterCallSid(callSid: string, socket: Socket) {
    const sockets = this.callSidToSocketMap.get(callSid);
    if (sockets) {
      const index = sockets.indexOf(socket);
      if (index > -1) {
        sockets.splice(index, 1);
      }
      if (sockets.length === 0) {
        this.callSidToSocketMap.delete(callSid);
      }
    }
  }

  // Clean up socket from all callSid mappings
  private cleanupSocketFromCallMappings(socket: Socket) {
    for (const [callSid, sockets] of this.callSidToSocketMap.entries()) {
      const index = sockets.indexOf(socket);
      if (index > -1) {
        sockets.splice(index, 1);
        if (sockets.length === 0) {
          this.callSidToSocketMap.delete(callSid);
        }
      }
    }
  }

  // Replay recent events for a newly registered client
  private replayRecentEvents(callSid: string, client: Socket) {
    console.log(`🚀 ~ replayRecentEvents ~ callSid: ${callSid}`);
    console.log(`🚀 ~ replayRecentEvents ~ recentEvents keys:`, Array.from(this.recentEvents.keys()));

    const events = this.recentEvents.get(callSid);
    console.log(`🚀 ~ replayRecentEvents ~ events for callSid:`, events);

    if (events && events.length > 0) {
      console.log(`🚀 ~ Replaying ${events.length} recent events for callSid: ${callSid}`);
      events.forEach((event, index) => {
        console.log(`🚀 ~ Replaying event ${index + 1}:`, event);
        client.emit('conversationEvent', {
          callSid,
          eventType: event.eventType,
          data: event.data,
          timestamp: event.timestamp,
        });
      });
    } else {
      console.log(`🚀 ~ No recent events found for callSid: ${callSid}`);
    }
  }

  // Store event for potential replay
  private storeEvent(callSid: string, eventType: string, data: any) {
    if (!this.recentEvents.has(callSid)) {
      this.recentEvents.set(callSid, []);
    }

    const events = this.recentEvents.get(callSid)!;
    const newEvent = {
      eventType,
      data,
      timestamp: new Date().toISOString(),
    };

    events.push(newEvent);

    // Keep only recent events (last 5 minutes)
    const cutoffTime = Date.now() - this.EVENT_RETENTION_MS;
    const filteredEvents = events.filter((event) => new Date(event.timestamp).getTime() > cutoffTime);
    this.recentEvents.set(callSid, filteredEvents);
  }

  // Method to broadcast conversation events to Socket.IO clients
  // This will be called from the TwilioGateway when conversation events occur
  public broadcastConversationEvent(callSid: string, eventType: string, data: any) {
    // Store event for potential replay
    this.storeEvent(callSid, eventType, data);

    const sockets = this.callSidToSocketMap.get(callSid);

    if (sockets && sockets.length > 0) {
      this.logger.log(`Broadcasting ${eventType} to ${sockets.length} clients for callSid: ${callSid}`);
      sockets.forEach((socket) => {
        socket.emit('conversationEvent', {
          callSid,
          eventType,
          data,
          timestamp: new Date().toISOString(),
        });
      });
    } else {
      this.logger.debug(`No Socket.IO clients found for callSid: ${callSid}`);
    }
  }

  // Get active callSids (for debugging/monitoring)
  public getActiveCallSids(): string[] {
    return Array.from(this.callSidToSocketMap.keys());
  }

  // Get client count for a specific callSid
  public getClientCountForCall(callSid: string): number {
    const sockets = this.callSidToSocketMap.get(callSid);
    return sockets ? sockets.length : 0;
  }
}
