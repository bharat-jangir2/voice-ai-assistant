import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Service for sending emails with conversation log links
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    this.initializeTransporter();
  }

  /**
   * Initialize the email transporter with SMTP configuration
   */
  private initializeTransporter(): void {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const password = this.configService.get<string>('SMTP_PASSWORD');

    if (!host || !port || !user || !password) {
      this.logger.warn('SMTP configuration incomplete. Email service will not be available.');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for other ports
      auth: {
        user,
        pass: password,
      },
    });

    this.logger.log('Email transporter initialized successfully');
  }

  /**
   * Send conversation log link via email
   * @param sessionId - The conversation session ID
   * @param assistantType - The type of assistant used
   * @param phoneNumber - The phone number of the caller (optional)
   * @param totalInteractions - Number of interactions in the conversation
   * @param callDuration - Duration of the call in milliseconds (optional)
   */
  async sendConversationLogEmail(
    sessionId: string,
    assistantType: string,
    phoneNumber?: string,
    totalInteractions?: number,
    callDuration?: number,
  ): Promise<boolean> {
    try {
      if (!this.transporter) {
        this.logger.error('Email transporter not initialized. Cannot send email.');
        return false;
      }

      const baseUrl = this.configService.get<string>('BASE_URL');
      const fromName = this.configService.get<string>('SMTP_FROM_NAME') || 'AI Voice Assistant';
      const fromEmail = this.configService.get<string>('SMTP_EMAIL_FROM');
      const toEmail = this.configService.get<string>('SMTP_EMAIL_TO');

      if (!baseUrl || !fromEmail || !toEmail) {
        this.logger.error('Missing required email configuration: BASE_URL, SMTP_EMAIL_FROM, or SMTP_EMAIL_TO');
        return false;
      }

      const conversationLogUrl = `${baseUrl}/conversation-logs/session/${sessionId}`;

      // Format call duration
      const formattedDuration = callDuration ? this.formatDuration(callDuration) : 'Unknown';

      // Create email content
      const subject = `Conversation Log - ${assistantType} Assistant - Session ${sessionId}`;
      const htmlContent = this.createEmailContent(
        sessionId,
        assistantType,
        conversationLogUrl,
        phoneNumber,
        totalInteractions,
        formattedDuration,
      );

      const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: toEmail,
        subject,
        html: htmlContent,
      };

      const result = await this.transporter.sendMail(mailOptions);
      this.logger.log(`Conversation log email sent successfully to ${toEmail}. Message ID: ${result.messageId}`);

      return true;
    } catch (error) {
      this.logger.error('Failed to send conversation log email:', error);
      return false;
    }
  }

  /**
   * Send conversation JSON file directly via email
   * @param sessionId - The conversation session ID
   * @param assistantType - The type of assistant used
   * @param phoneNumber - The phone number of the caller (optional)
   * @param totalInteractions - Number of interactions in the conversation
   * @param callDuration - Duration of the call in milliseconds (optional)
   * @param jsonContent - The JSON content of the conversation
   */
  async sendConversationJsonEmail(
    sessionId: string,
    assistantType: string,
    phoneNumber?: string,
    totalInteractions?: number,
    callDuration?: number,
    jsonContent?: string,
  ): Promise<boolean> {
    try {
      if (!this.transporter) {
        this.logger.error('Email transporter not initialized. Cannot send email.');
        return false;
      }

      const fromName = this.configService.get<string>('SMTP_FROM_NAME') || 'AI Voice Assistant';
      const fromEmail = this.configService.get<string>('SMTP_EMAIL_FROM');

      // Get email recipients from environment variable or use default
      const emailRecipients = this.configService.get<string>('CONVERSATION_EMAIL_RECIPIENTS');
      const toEmails = emailRecipients
        ? emailRecipients.split(',').map((email) => email.trim())
        : ['ramsample1@gmail.com', 'ramsample2@gmail.com'];

      if (!fromEmail) {
        this.logger.error('Missing required email configuration: SMTP_EMAIL_FROM');
        return false;
      }

      // Format call duration
      const formattedDuration = callDuration ? this.formatDuration(callDuration) : 'Unknown';

      // Create email content
      const subject = `Conversation JSON - ${assistantType} Assistant - Session ${sessionId}`;
      const htmlContent = this.createJsonEmailContent(
        sessionId,
        assistantType,
        phoneNumber,
        totalInteractions,
        formattedDuration,
      );

      const mailOptions: any = {
        from: `"${fromName}" <${fromEmail}>`,
        to: toEmails.join(', '), // Send to multiple recipients
        subject,
        html: htmlContent,
      };

      // Attach JSON file if content is provided
      if (jsonContent) {
        mailOptions.attachments = [
          {
            filename: `conversation-${sessionId}.json`,
            content: jsonContent,
            contentType: 'application/json',
          },
        ];
      }

      const result = await this.transporter.sendMail(mailOptions);
      this.logger.log(`Conversation JSON email sent successfully to ${toEmails.join(', ')}. Message ID: ${result.messageId}`);

      return true;
    } catch (error) {
      this.logger.error('Failed to send conversation JSON email:', error);
      return false;
    }
  }

  /**
   * Create HTML email content
   */
  private createEmailContent(
    sessionId: string,
    assistantType: string,
    conversationLogUrl: string,
    phoneNumber?: string,
    totalInteractions?: number,
    callDuration?: string,
  ): string {
    const assistantDisplayName = this.getAssistantDisplayName(assistantType);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Conversation Log</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .content { background-color: #ffffff; padding: 20px; border: 1px solid #dee2e6; border-radius: 5px; }
          .button { display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .details { background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .detail-row { margin: 5px 0; }
          .label { font-weight: bold; color: #495057; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🤖 AI Voice Assistant - Conversation Log</h2>
            <p>A conversation has ended and the log is ready for review.</p>
          </div>
          
          <div class="content">
            <h3>Conversation Details</h3>
            
            <div class="details">
              <div class="detail-row">
                <span class="label">Assistant Type:</span> ${assistantDisplayName}
              </div>
              <div class="detail-row">
                <span class="label">Session ID:</span> ${sessionId}
              </div>
              ${phoneNumber ? `<div class="detail-row"><span class="label">Phone Number:</span> ${phoneNumber}</div>` : ''}
              ${totalInteractions ? `<div class="detail-row"><span class="label">Total Interactions:</span> ${totalInteractions}</div>` : ''}
              ${callDuration ? `<div class="detail-row"><span class="label">Call Duration:</span> ${callDuration}</div>` : ''}
            </div>
            
            <p>Click the button below to view the complete conversation log:</p>
            
            <a href="${conversationLogUrl}" class="button">📋 View Conversation Log</a>
            
            <p style="margin-top: 20px; font-size: 12px; color: #6c757d;">
              This link provides access to the complete conversation including user inputs, AI responses, processing details, and performance metrics.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Create HTML email content for JSON files
   */
  private createJsonEmailContent(
    sessionId: string,
    assistantType: string,
    phoneNumber?: string,
    totalInteractions?: number,
    callDuration?: string,
  ): string {
    const assistantDisplayName = this.getAssistantDisplayName(assistantType);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Conversation JSON</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .content { background-color: #ffffff; padding: 20px; border: 1px solid #dee2e6; border-radius: 5px; }
          .button { display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .details { background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .detail-row { margin: 5px 0; }
          .label { font-weight: bold; color: #495057; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🤖 AI Voice Assistant - Conversation JSON</h2>
            <p>A conversation JSON file is ready for review.</p>
          </div>
          
          <div class="content">
            <h3>Conversation Details</h3>
            
            <div class="details">
              <div class="detail-row">
                <span class="label">Assistant Type:</span> ${assistantDisplayName}
              </div>
              <div class="detail-row">
                <span class="label">Session ID:</span> ${sessionId}
              </div>
              ${phoneNumber ? `<div class="detail-row"><span class="label">Phone Number:</span> ${phoneNumber}</div>` : ''}
              ${totalInteractions ? `<div class="detail-row"><span class="label">Total Interactions:</span> ${totalInteractions}</div>` : ''}
              ${callDuration ? `<div class="detail-row"><span class="label">Call Duration:</span> ${callDuration}</div>` : ''}
            </div>
            
            <p>The conversation JSON file is attached to this email.</p>
            
            <div style="background-color: #e7f3ff; padding: 15px; border-radius: 5px; border-left: 4px solid #007bff; margin: 15px 0;">
              <p style="margin: 0; color: #0056b3;">
                <strong>📎 Attachment:</strong> conversation-${sessionId}.json
              </p>
            </div>
            
            <p style="margin-top: 20px; font-size: 12px; color: #6c757d;">
              The attached JSON file contains the complete conversation data including user inputs, AI responses, processing details, and performance metrics. You can open it with any text editor or JSON viewer.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Get display name for assistant type
   */
  private getAssistantDisplayName(assistantType: string): string {
    const displayNames: Record<string, string> = {
      general: 'General Assistant',
      hospital: 'Hospital Support Assistant',
      speedel: 'Speedel Phone Assistant',
      appraisee: 'Appraisee Assistant',
      'prep-my-vehicle': 'Vehicle Preparation Assistant',
    };

    return displayNames[assistantType] || assistantType;
  }

  /**
   * Format duration from milliseconds to human readable format
   */
  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${remainingSeconds}s`;
    }
  }

  /**
   * Send a generic email
   * @param options - Email options (to, subject, html, text)
   */
  async sendEmail(options: { to: string; subject: string; html?: string; text?: string }): Promise<boolean> {
    try {
      if (!this.transporter) {
        this.logger.error('Email transporter not initialized');
        return false;
      }

      const fromEmail = this.configService.get<string>('SMTP_EMAIL_FROM');
      if (!fromEmail) {
        this.logger.error('SMTP_EMAIL_FROM not configured');
        return false;
      }

      const mailOptions = {
        from: `"AI Voice Assistant" <${fromEmail}>`,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      };

      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email sent successfully to ${options.to}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${options.to}:`, error);
      return false;
    }
  }

  /**
   * Test email configuration
   */
  async testEmailConfiguration(): Promise<boolean> {
    try {
      if (!this.transporter) {
        this.logger.error('Email transporter not initialized');
        return false;
      }

      const fromEmail = this.configService.get<string>('SMTP_EMAIL_FROM');
      const toEmail = this.configService.get<string>('SMTP_EMAIL_TO');

      if (!fromEmail || !toEmail) {
        this.logger.error('Missing email configuration');
        return false;
      }

      const testMailOptions = {
        from: `"AI Voice Assistant Test" <${fromEmail}>`,
        to: toEmail,
        subject: 'Test Email - AI Voice Assistant',
        html: '<h2>Test Email</h2><p>This is a test email to verify the email configuration is working correctly.</p>',
      };

      await this.transporter.sendMail(testMailOptions);
      this.logger.log('Test email sent successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to send test email:', error);
      return false;
    }
  }
}
