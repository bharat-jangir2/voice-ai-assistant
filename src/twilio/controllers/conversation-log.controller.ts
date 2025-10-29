import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConversationLoggerService, ConversationSession } from '../services/conversation-logger.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Controller for accessing conversation logs for analysis
 */
@Controller('conversation-logs')
export class ConversationLogController {
  constructor(private readonly conversationLogger: ConversationLoggerService) {}

  // Retrieves a specific conversation session by session ID
  @Get('session/:sessionId')
  async getSession(@Param('sessionId') sessionId: string) {
    const session = await this.conversationLogger.getSession(sessionId);
    if (!session) {
      return {
        error: 'Session not found',
        sessionId,
      };
    }

    return {
      sessionId,
      session,
    };
  }

  // Gets conversation sessions filtered by assistant type with optional limit
  @Get('assistant/:assistantType')
  async getAssistantSessions(@Param('assistantType') assistantType: string, @Query('limit') limit: string = '100') {
    const limitNumber = parseInt(limit, 10) || 100;
    const sessions = await this.conversationLogger.getSessionsByAssistant(assistantType, limitNumber);

    return {
      assistantType,
      totalSessions: sessions.length,
      limit: limitNumber,
      sessions,
    };
  }

  // Returns summary statistics for all conversation sessions
  @Get('summary')
  async getSessionsSummary() {
    return await this.conversationLogger.getSessionsSummary();
  }

  // Exports conversation sessions as JSON file with optional filtering
  @Get('export')
  async exportSessions(
    @Query('assistantType') assistantType?: string,
    @Query('sessionId') sessionId?: string,
    @Res() res?: Response,
  ) {
    try {
      let sessions: ConversationSession[] = [];
      let filename = '';

      if (sessionId) {
        const session = await this.conversationLogger.getSession(sessionId);
        sessions = session ? [session] : [];
        filename = `conversation-session-${sessionId}.json`;
      } else if (assistantType) {
        sessions = await this.conversationLogger.getSessionsByAssistant(assistantType, 10000);
        filename = `conversation-sessions-${assistantType}.json`;
      } else {
        // Export all sessions (this might be slow for large datasets)
        const assistantTypes = ['general', 'hospital', 'speedel', 'appraisee', 'prep-my-vehicle'];
        for (const type of assistantTypes) {
          const typeSessions = await this.conversationLogger.getSessionsByAssistant(type, 1000);
          sessions.push(...typeSessions);
        }
        filename = `conversation-sessions-all.json`;
      }

      if (res) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(sessions);
      } else {
        return {
          filename,
          totalSessions: sessions.length,
          sessions,
        };
      }
    } catch (error) {
      if (res) {
        res.status(500).json({
          error: 'Failed to export sessions',
          message: error.message,
        });
      } else {
        return {
          error: 'Failed to export sessions',
          message: error.message,
        };
      }
    }
  }

  // Ends a conversation session and sends email notification
  @Get('session/:sessionId/end')
  async endSession(@Param('sessionId') sessionId: string) {
    try {
      await this.conversationLogger.endSession(sessionId);
      return {
        message: 'Session ended successfully and JSON email notification sent',
        sessionId,
      };
    } catch (error) {
      return {
        error: 'Failed to end session',
        message: error.message,
        sessionId,
      };
    }
  }

  // Manually send JSON email for a specific session
  @Get('session/:sessionId/send-json-email')
  async sendJsonEmail(@Param('sessionId') sessionId: string) {
    try {
      const session = await this.conversationLogger.getSession(sessionId);
      if (!session) {
        return {
          error: 'Session not found',
          sessionId,
        };
      }

      // Read the JSON file content
      const filePath = path.join(process.cwd(), 'logs', 'conversations', `${sessionId}.json`);
      let jsonContent: string | undefined;
      let fileExists = false;
      
      if (fs.existsSync(filePath)) {
        jsonContent = fs.readFileSync(filePath, 'utf8');
        fileExists = true;
      }

      const emailService = this.conversationLogger['emailService'];
      const emailSent = await emailService.sendConversationJsonEmail(
        session.sessionId,
        session.assistantType,
        session.metadata.phoneNumber,
        session.totalInteractions,
        session.metadata.callDuration,
        jsonContent,
      );

      if (emailSent) {
        // Delete the conversation file after successful email send
        if (fileExists) {
          try {
            fs.unlinkSync(filePath);
            console.log(`Deleted conversation file for session: ${sessionId}`);
          } catch (deleteError) {
            console.warn(`Failed to delete conversation file for session ${sessionId}:`, deleteError);
          }
        }
        
        return {
          message: 'JSON email sent successfully and file deleted',
          sessionId,
          status: 'success',
        };
      } else {
        return {
          error: 'Failed to send JSON email',
          sessionId,
          status: 'error',
        };
      }
    } catch (error) {
      return {
        error: 'Failed to send JSON email',
        message: error.message,
        sessionId,
        status: 'error',
      };
    }
  }

  // Calculates and returns detailed statistics for a specific session
  @Get('session/:sessionId/stats')
  async getSessionStats(@Param('sessionId') sessionId: string) {
    try {
      const session = await this.conversationLogger.getSession(sessionId);
      if (!session) {
        return {
          error: 'Session not found',
          sessionId,
        };
      }

      const interactions = session.interactions;
      const totalInteractions = interactions.length;
      const errorInteractions = interactions.filter((i) => i.error).length;
      // const avgSearchTime = interactions.reduce((sum, i) => sum + i.contextRetrieval.searchTime, 0) / totalInteractions;
      // const avgResponseTime = interactions.reduce((sum, i) => sum + i.aiResponse.responseTime, 0) / totalInteractions;
      // const avgResponseLength = interactions.reduce((sum, i) => sum + i.aiResponse.response.length, 0) / totalInteractions;

      return {
        sessionId,
        stats: {
          totalInteractions,
          errorInteractions,
          errorRate: totalInteractions > 0 ? ((errorInteractions / totalInteractions) * 100).toFixed(2) + '%' : '0%',
          // averageSearchTime: Math.round(avgSearchTime),
          // averageResponseTime: Math.round(avgResponseTime),
          // averageResponseLength: Math.round(avgResponseLength),
          sessionDuration: session.metadata.callDuration,
          startTime: session.startTime,
          lastUpdateTime: session.lastUpdateTime,
        },
      };
    } catch (error) {
      return {
        error: 'Failed to get session stats',
        message: error.message,
        sessionId,
      };
    }
  }

  // Tests email configuration by sending a test email
  @Get('test-email')
  async testEmail() {
    try {
      const emailService = this.conversationLogger['emailService']; // Access the email service
      const success = await emailService.testEmailConfiguration();

      if (success) {
        return {
          message: 'Test email sent successfully',
          status: 'success',
        };
      } else {
        return {
          message: 'Failed to send test email',
          status: 'error',
        };
      }
    } catch (error) {
      return {
        error: 'Failed to test email configuration',
        message: error.message,
        status: 'error',
      };
    }
  }

  // Sends email notification for a specific conversation session
  @Get('session/:sessionId/send-email')
  async sendSessionEmail(@Param('sessionId') sessionId: string) {
    try {
      const session = await this.conversationLogger.getSession(sessionId);
      if (!session) {
        return {
          error: 'Session not found',
          sessionId,
        };
      }

      const emailService = this.conversationLogger['emailService'];
      const emailSent = await emailService.sendConversationLogEmail(
        session.sessionId,
        session.assistantType,
        session.metadata.phoneNumber,
        session.totalInteractions,
        session.metadata.callDuration,
      );

      if (emailSent) {
        return {
          message: 'Email notification sent successfully',
          sessionId,
          status: 'success',
        };
      } else {
        return {
          error: 'Failed to send email notification',
          sessionId,
          status: 'error',
        };
      }
    } catch (error) {
      return {
        error: 'Failed to send email notification',
        message: error.message,
        sessionId,
        status: 'error',
      };
    }
  }
}
