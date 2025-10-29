import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Twilio from 'twilio';

@Injectable()
export class TwilioApiService {
  private readonly logger = new Logger(TwilioApiService.name);
  private readonly client: Twilio.Twilio;
  private readonly twilioPhoneNumber: string;
  private readonly twimlAppSid: string;

  constructor(private readonly configService: ConfigService) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    this.twilioPhoneNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER')!;
    this.twimlAppSid = this.configService.get<string>('TWIML_APP_SID')!;

    if (!accountSid || !authToken || !this.twilioPhoneNumber || !this.twimlAppSid) {
      this.logger.error('Twilio API credentials or TwiML App SID are not fully configured in environment variables.');
      throw new Error('Twilio API credentials or TwiML App SID are not configured.');
    }
    this.client = Twilio(accountSid, authToken);
  }

  async makeCall(toPhoneNumber: string): Promise<{ callSid: string }> {
    try {
      this.logger.log(`Initiating call to ${toPhoneNumber} from ${this.twilioPhoneNumber} using TwiML App ${this.twimlAppSid}`);
      const call = await this.client.calls.create({
        to: toPhoneNumber,
        from: this.twilioPhoneNumber,
        applicationSid: this.twimlAppSid,
      });
      this.logger.log(`Call initiated with SID: ${call.sid}`);
      return { callSid: call.sid };
    } catch (error) {
      this.logger.error(`Error initiating call: ${error.message}`, error.stack);
      throw new Error(`Failed to initiate call: ${error.message}`);
    }
  }

  async endCall(callSid: string): Promise<{ callSid: string; status: string }> {
    try {
      this.logger.log(`Attempting to end call: ${callSid}`);
      const call = await this.client.calls(callSid).update({
        status: 'completed',
      });
      this.logger.log(`Call ${callSid} status updated to: ${call.status}`);
      return { callSid: call.sid, status: call.status };
    } catch (error) {
      this.logger.error(`Error ending call ${callSid}: ${error.message}`, error.stack);
      throw new Error(`Failed to end call ${callSid}: ${error.message}`);
    }
  }
}
