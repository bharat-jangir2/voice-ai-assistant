import { Logger, Injectable } from '@nestjs/common';

@Injectable()
export class CustomLogger extends Logger {
  private formatMessage(message: any, emoji: string): string {
    return `${emoji} ${message}`;
  }

  log(message: any, context?: string) {
    const formatted = this.formatMessage(message, '🚀');
    context ? super.log(formatted, context) : super.log(formatted);
  }

  error(message: any, trace?: string, context?: string) {
    const formatted = this.formatMessage(message, '❌');
    context ? super.error(formatted, trace, context) : super.error(formatted, trace);
  }

  warn(message: any, context?: string) {
    const formatted = this.formatMessage(message, '⚠️');
    context ? super.warn(formatted, context) : super.warn(formatted);
  }

  debug(message: any, context?: string) {
    const formatted = this.formatMessage(message, '🐛');
    context ? super.debug(formatted, context) : super.debug(formatted);
  }

  verbose(message: any, context?: string) {
    const formatted = this.formatMessage(message, '🔍');
    context ? super.verbose(formatted, context) : super.verbose(formatted);
  }
}
